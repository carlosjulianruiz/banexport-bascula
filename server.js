const express = require('express');
const http = require('http');
const net = require('net');
const { Server } = require('socket.io');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');
const cors = require('cors');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const twilio = require('twilio'); // IMPORTANTE: Haber hecho npm install twilio
const { ThermalPrinter, PrinterTypes, CharacterSet } = require('node-thermal-printer');

// --- 1. CONFIGURACIÓN BASE DE DATOS ---
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./banexport_pesajes.db');

db.serialize(() => {
    // Pesajes
    db.run(`CREATE TABLE IF NOT EXISTS pesajes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        placa TEXT NOT NULL,
        conductor TEXT,
        cedula TEXT,
        producto TEXT,
        observaciones TEXT,
        telefonos TEXT,
        peso_entrada REAL,
        peso_salida REAL,
        peso_neto REAL,
        fecha_entrada TEXT,
        fecha_salida TEXT,
        estado TEXT DEFAULT 'ABIERTO'
    )`);
    db.run(`ALTER TABLE pesajes ADD COLUMN cedula TEXT`, () => {});

    // Muchos a Muchos: Placa - Conductores
    db.run(`CREATE TABLE IF NOT EXISTS placa_conductores (
        placa TEXT,
        conductor TEXT,
        cedula TEXT,
        telefonos TEXT,
        ultimo_uso DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (placa, conductor)
    )`);
    db.run(`ALTER TABLE placa_conductores ADD COLUMN cedula TEXT`, () => {});

    // Empresa + Twilio
    db.run(`CREATE TABLE IF NOT EXISTS empresa (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT, nit TEXT, telefono TEXT, correo TEXT, direccion TEXT,
        twilio_sid TEXT, twilio_token TEXT, twilio_phone TEXT
    )`);
    db.run(`ALTER TABLE empresa ADD COLUMN printer_ip TEXT`, () => {});
    db.run(`ALTER TABLE empresa ADD COLUMN printer_mac TEXT`, () => {});

    // Migración: normaliza datos históricos (placas solo alfanuméricas, textos sin espacios sobrantes)
    const LIMPIA_PLACA = `REPLACE(REPLACE(REPLACE(placa, ' ', ''), '.', ''), '-', '')`;
    db.run(`UPDATE pesajes SET placa = ${LIMPIA_PLACA}, conductor = TRIM(conductor),
            cedula = TRIM(cedula), producto = TRIM(producto), telefonos = TRIM(telefonos)`);
    db.run(`UPDATE OR IGNORE placa_conductores SET placa = ${LIMPIA_PLACA}, conductor = TRIM(conductor)`);
    db.run(`DELETE FROM placa_conductores WHERE placa LIKE '% %' OR placa LIKE '%.%' OR placa LIKE '%-%'`);

    db.get("SELECT COUNT(*) as count FROM empresa", (err, row) => {
        if (row && row.count === 0) {
            db.run(`INSERT INTO empresa (nombre, nit, telefono, correo, direccion) 
                    VALUES ('BANEXPORT S.A.', '900.XXX.XXX', '300 000 0000', 'admin@banexport.com', 'CALLE PRINCIPAL #123')`);
        }
    });
});

const dbGet = (sql, params) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
const dbRun = (sql, params) => new Promise((resolve, reject) => db.run(sql, params, function(err) { err ? reject(err) : resolve(this) }));
const dbAll = (sql, params) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));

function normalizarPlaca(placa) {
    return (placa || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function obtenerFechaColombia() {
    const fecha = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Bogota"}));
    const f = (n) => String(n).padStart(2, '0');
    return `${fecha.getFullYear()}-${f(fecha.getMonth()+1)}-${f(fecha.getDate())} ${f(fecha.getHours())}:${f(fecha.getMinutes())}:${f(fecha.getSeconds())}`;
}

// --- 2. FUNCIÓN DE ENVÍO WHATSAPP ---
async function enviarWhatsApp(telefonos, cuerpoTiquete) {
    const emp = await dbGet("SELECT * FROM empresa LIMIT 1");
    
    // Limpiamos el número de emisor para que no lleve espacios raros
    const emisorLimpio = emp.twilio_phone.replace(/\s+/g, ''); 
    const fromWhatsApp = `whatsapp:${emisorLimpio}`; 

    const client = new twilio(emp.twilio_sid, emp.twilio_token);
    const listaNumeros = telefonos.split(',').map(n => n.trim());

    for (let num of listaNumeros) {
        if (num.length < 10) continue;
        const toNum = num.startsWith('+') ? num : `+57${num}`;
        
        try {
            await client.messages.create({
                body: cuerpoTiquete,
                from: fromWhatsApp,
                to: `whatsapp:${toNum}`
            });
            console.log(`✅ Tiquete enviado a ${toNum}`);
        } catch (e) {
            console.error(`❌ Error: ${e.message}`);
        }
    }
}

// --- 3. CONFIGURACIÓN SERVIDOR ---
const PORT_WEB = process.env.PORT_WEB || 3000;
const app = express();
app.use(cors()); app.use(express.json()); app.use(express.static('Public'));
const server = http.createServer(app);
const io = new Server(server);

let pesoActual = 0.0;

// --- LECTURA PUERTO SERIAL (Fairbanks IND-R2500) ---
// Formato Condec: STX + status(2 bytes) + peso_bruto(6 chars) + peso_neto(6 chars) + CR
const SERIAL_PORT = process.platform === 'linux' ? '/dev/ttyUSB0' : '/dev/cu.usbserial-2110';
const SERIAL_BAUD = 9600;

try {
    const serialPort = new SerialPort({ path: SERIAL_PORT, baudRate: SERIAL_BAUD, dataBits: 7, parity: 'even', stopBits: 1 });
    const parser = serialPort.pipe(new ReadlineParser({ delimiter: '\r' }));

    parser.on('data', (line) => {
        // Trama: STX(1) + status(2) + space(1) + peso_bruto(6) + peso_neto(6)
        // Ejemplo con peso 0: "\x02)0      0     0"
        if (line.length >= 10 && line.charCodeAt(0) === 0x02) {
            const pesoBruto = parseFloat(line.substring(4, 10));
            if (!isNaN(pesoBruto)) {
                pesoActual = pesoBruto;
                io.emit('peso_live', pesoActual);
            }
        }
    });

    serialPort.on('open', () => console.log(`✅ Puerto serial ${SERIAL_PORT} abierto (${SERIAL_BAUD},7,E,1)`));
    serialPort.on('error', (err) => console.error(`❌ Error serial: ${err.message}`));
} catch (err) {
    console.error(`⚠️ No se pudo abrir puerto serial: ${err.message}`);
    console.log('📡 Modo simulación activado');
    setInterval(() => { pesoActual = 15000 + (Math.random() * 5); io.emit('peso_live', pesoActual); }, 500);
}

async function findIpByMac(mac) {
    if (!mac) return null;
    const target = mac.toLowerCase().trim();
    try {
        const { stdout } = await execAsync('sudo -n arp-scan --localnet --retry=2 2>/dev/null', { timeout: 15000 });
        for (const line of stdout.split('\n')) {
            const m = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f:]{17})/i);
            if (m && m[2].toLowerCase() === target) return m[1];
        }
    } catch (e) {
        console.error(`❌ arp-scan falló: ${e.message}`);
    }
    return null;
}

async function ejecutarImpresion(printerIp, texto) {
    const printer = new ThermalPrinter({
        type: PrinterTypes.EPSON,
        interface: `tcp://${printerIp}:9100`,
        characterSet: CharacterSet.PC850_MULTILINGUAL,
        removeSpecialCharacters: false,
        options: { timeout: 5000 }
    });

    if (!(await printer.isPrinterConnected())) return false;

    for (const raw of texto.split('\n')) {
        const linea = raw.replace(/^\s+/, '');
        if (linea === '') { printer.newLine(); continue; }
        if (/^-{3,}$/.test(linea)) { printer.drawLine(); continue; }
        const full = linea.match(/^\*(.+)\*$/);
        if (full) {
            printer.alignCenter();
            printer.bold(true);
            printer.println(full[1]);
            printer.bold(false);
            printer.alignLeft();
            continue;
        }
        printer.println(linea.replace(/\*/g, ''));
    }
    printer.cut();
    await printer.execute();
    return true;
}

async function imprimirTiquete(texto) {
    try {
        const emp = await dbGet("SELECT printer_ip, printer_mac FROM empresa LIMIT 1");
        if (!emp || (!emp.printer_ip && !emp.printer_mac)) {
            console.log("\n--- 🖨️ SIN IMPRESORA CONFIGURADA ---\n" + texto);
            return;
        }

        if (emp.printer_ip) {
            try {
                if (await ejecutarImpresion(emp.printer_ip, texto)) {
                    console.log(`✅ Tiquete impreso en ${emp.printer_ip}`);
                    return;
                }
            } catch (e) {
                console.error(`⚠️ Falló impresión en ${emp.printer_ip}: ${e.message}`);
            }
            console.log(`⚠️ ${emp.printer_ip} no responde`);
        }

        if (emp.printer_mac) {
            console.log(`🔎 Buscando impresora por MAC ${emp.printer_mac}...`);
            const nuevaIp = await findIpByMac(emp.printer_mac);
            if (nuevaIp && nuevaIp !== emp.printer_ip) {
                console.log(`📍 IP actualizada: ${emp.printer_ip || 'N/A'} → ${nuevaIp}`);
                await dbRun("UPDATE empresa SET printer_ip=? WHERE id=1", [nuevaIp]);
                if (await ejecutarImpresion(nuevaIp, texto)) {
                    console.log(`✅ Tiquete impreso en ${nuevaIp}`);
                    return;
                }
            } else if (!nuevaIp) {
                console.error(`❌ MAC ${emp.printer_mac} no encontrada en la red`);
            }
        }

        console.error(`❌ No se pudo imprimir el tiquete`);
    } catch (e) {
        console.error(`❌ Error impresión: ${e.message}`);
    }
}

// --- 4. RUTAS API ---

app.get('/api/empresa', async (req, res) => res.json(await dbGet("SELECT * FROM empresa LIMIT 1")));

function chequearImpresora(ip, timeout = 1500) {
    return new Promise((resolve) => {
        if (!ip) return resolve(false);
        const socket = new net.Socket();
        let resuelto = false;
        const fin = (ok) => { if (resuelto) return; resuelto = true; socket.destroy(); resolve(ok); };
        socket.setTimeout(timeout);
        socket.once('connect', () => fin(true));
        socket.once('timeout', () => fin(false));
        socket.once('error', () => fin(false));
        socket.connect(9100, ip);
    });
}

app.get('/api/printer/status', async (req, res) => {
    const emp = await dbGet("SELECT printer_ip, printer_mac FROM empresa LIMIT 1");
    const ip = emp?.printer_ip || null;
    const connected = await chequearImpresora(ip);
    res.json({ connected, ip, mac: emp?.printer_mac || null });
});

app.post('/api/empresa', async (req, res) => {
    const { nombre, nit, telefono, correo, direccion, twilio_sid, twilio_token, twilio_phone, printer_ip, printer_mac } = req.body;
    const macNormalizada = (printer_mac || '').toLowerCase().trim();
    await dbRun("UPDATE empresa SET nombre=?, nit=?, telefono=?, correo=?, direccion=?, twilio_sid=?, twilio_token=?, twilio_phone=?, printer_ip=?, printer_mac=? WHERE id=1",
        [nombre.toUpperCase(), nit, telefono, correo.toLowerCase(), direccion.toUpperCase(), twilio_sid, twilio_token, twilio_phone, printer_ip, macNormalizada]);
    res.json({ mensaje: "Ok" });
});

app.get('/api/vehiculo/:placa', async (req, res) => {
    const placa = normalizarPlaca(req.params.placa);
    const abierta = await dbGet("SELECT * FROM pesajes WHERE placa = ? AND estado = 'ABIERTO'", [placa]);
    const conductores = await dbAll("SELECT conductor, cedula, telefonos FROM placa_conductores WHERE placa = ? ORDER BY ultimo_uso DESC", [placa]);
    res.json({ estado: abierta ? 'EN_PLANTA' : 'NUEVO', datos_pesaje: abierta, conductores });
});

app.get('/api/maestro-vehiculos', async (req, res) => {
    const data = await dbAll(`SELECT * FROM placa_conductores ORDER BY ultimo_uso DESC`, []);
    res.json(data);
});

app.get('/api/historial', async (req, res) => {
    const { page=1, search='', fechaInicio='', fechaFin='' } = req.query;
    const limit = 50; const offset = (page - 1) * limit;
    let cond = [], params = [];
    if(search) { cond.push("(placa LIKE ? OR conductor LIKE ?)"); params.push(`%${search}%`, `%${search}%`); }
    if(fechaInicio) { cond.push("DATE(fecha_entrada) >= DATE(?)"); params.push(fechaInicio); }
    if(fechaFin) { cond.push("DATE(fecha_entrada) <= DATE(?)"); params.push(fechaFin); }
    let where = cond.length > 0 ? "WHERE " + cond.join(" AND ") : "";
    const total = await dbGet(`SELECT COUNT(*) as t FROM pesajes ${where}`, params);
    const data = await dbAll(`SELECT * FROM pesajes ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    res.json({ data, total: total.t, page: parseInt(page), totalPages: Math.ceil(total.t / limit) });
});

app.post('/api/registrar', async (req, res) => {
    const limpiar = (v) => (v || '').replace(/\s+/g, ' ').trim();
    const conductor = limpiar(req.body.conductor);
    const cedula = limpiar(req.body.cedula);
    const producto = limpiar(req.body.producto);
    const observaciones = limpiar(req.body.observaciones);
    const telefonos = limpiar(req.body.telefonos);
    const placa = normalizarPlaca(req.body.placa);
    if (!placa || placa.length < 3) return res.status(400).json({ error: 'Placa inválida' });
    if (!conductor) return res.status(400).json({ error: 'Conductor requerido' });
    const fechaHoy = obtenerFechaColombia();
    const emp = await dbGet("SELECT * FROM empresa LIMIT 1");

    await dbRun(`INSERT INTO placa_conductores (placa, conductor, cedula, telefonos, ultimo_uso)
                 VALUES (?, ?, ?, ?, ?) ON CONFLICT(placa, conductor) DO UPDATE SET cedula=excluded.cedula, telefonos=excluded.telefonos, ultimo_uso=excluded.ultimo_uso`,
                 [placa, conductor.toUpperCase(), cedula, telefonos, fechaHoy]);

    const abierta = await dbGet("SELECT * FROM pesajes WHERE placa = ? AND estado = 'ABIERTO'", [placa]);

    let tiqueteTxt = "";
    if (abierta) {
        const neto = Math.abs(abierta.peso_entrada - pesoActual);
        const obsSalida = observaciones.toUpperCase();
        const obsFinal = [abierta.observaciones, obsSalida]
            .filter(o => o && o.trim())
            .filter((o, i, arr) => arr.indexOf(o) === i)
            .join(' | ');
        await dbRun("UPDATE pesajes SET peso_salida=?, fecha_salida=?, peso_neto=?, observaciones=?, estado='CERRADO' WHERE id=?", [pesoActual, fechaHoy, neto, obsFinal, abierta.id]);
        
            tiqueteTxt = `*TIQUETE DE BÁSCULA*
            *${emp.nombre}*
            NIT: ${emp.nit}
            DIR: ${emp.direccion}
            TEL: ${emp.telefono}
            E-MAIL: ${emp.correo}
            --------------------------------
            *TIQUETE #:* ${abierta.id}
            *PLACA:* ${placa}
            *CONDUCTOR:* ${conductor.toUpperCase()}
            *CEDULA:* ${cedula || 'N/A'}

            *ENTRADA:* ${abierta.fecha_entrada}
            *SALIDA:* ${fechaHoy}

            *PESO BRUTO:* ${abierta.peso_entrada.toFixed(1)} kg
            *PESO TARA:* ${pesoActual.toFixed(1)} kg
            *PESO NETO:* ${neto.toFixed(1)} kg

            *PRODUCTO:* ${producto.toUpperCase()}
            --------------------------------`;
        
        imprimirTiquete(tiqueteTxt);
        enviarWhatsApp(telefonos, tiqueteTxt);
        res.json({ tipo: 'SALIDA', neto });
    } else {
        const r = await dbRun("INSERT INTO pesajes (placa, conductor, cedula, producto, observaciones, telefonos, peso_entrada, fecha_entrada) VALUES (?,?,?,?,?,?,?,?)",
            [placa, conductor.toUpperCase(), cedula, producto.toUpperCase(), observaciones.toUpperCase(), telefonos, pesoActual, fechaHoy]);

        tiqueteTxt = `*TIQUETE DE BÁSCULA (INGRESO)*
*${emp.nombre}*
NIT: ${emp.nit}
DIR: ${emp.direccion}
TEL: ${emp.telefono}
E-MAIL: ${emp.correo}
--------------------------------
*TIQUETE #:* ${r.lastID}
*PLACA:* ${placa}
*CONDUCTOR:* ${conductor.toUpperCase()}
*CEDULA:* ${cedula || 'N/A'}

*FECHA INGRESO:* ${fechaHoy}
*PESO ENTRADA:* ${pesoActual.toFixed(1)} kg

*PRODUCTO:* ${producto.toUpperCase()}
--------------------------------`;

        imprimirTiquete(tiqueteTxt);
        enviarWhatsApp(telefonos, tiqueteTxt);
        res.json({ tipo: 'ENTRADA', id: r.lastID });
    }
});

app.post('/api/reimprimir', async (req, res) => {
    const { id } = req.body;
    try {
        const reg = await dbGet("SELECT * FROM pesajes WHERE id = ?", [id]);
        if (!reg) return res.status(404).json({ error: "No encontrado" });
        
        const emp = await dbGet("SELECT * FROM empresa LIMIT 1");
        
        // Encabezado unificado con Teléfono, Email y marca de Reimpresión
        const enc = `*TIQUETE DE BÁSCULA*
*${emp.nombre}*
NIT: ${emp.nit}
DIR: ${emp.direccion}
TEL: ${emp.telefono}
E-MAIL: ${emp.correo}
*** REIMPRESION ***
--------------------------------`;
        
        let t = "";
        if (reg.estado === 'CERRADO') {
            t = `${enc}
*TIQUETE #:* ${reg.id}
*PLACA:* ${reg.placa}
*CONDUCTOR:* ${reg.conductor ? reg.conductor.toUpperCase() : 'N/A'}
*CEDULA:* ${reg.cedula || 'N/A'}

*INGRESO:* ${reg.fecha_entrada}
*SALIDA:* ${reg.fecha_salida}

*PESO BRUTO:* ${reg.peso_entrada.toFixed(1)} kg
*PESO TARA:* ${reg.peso_salida.toFixed(1)} kg
*PESO NETO:* ${reg.peso_neto.toFixed(1)} kg

*PRODUCTO:* ${reg.producto ? reg.producto.toUpperCase() : 'N/A'}
--------------------------------`;
        } else {
            t = `${enc}
*TIQUETE #:* ${reg.id} (INGRESO)
*PLACA:* ${reg.placa}
*CONDUCTOR:* ${reg.conductor ? reg.conductor.toUpperCase() : 'N/A'}
*CEDULA:* ${reg.cedula || 'N/A'}

*FECHA INGRESO:* ${reg.fecha_entrada}
*PESO ACTUAL:* ${reg.peso_entrada.toFixed(1)} kg

*PRODUCTO:* ${reg.producto ? reg.producto.toUpperCase() : 'N/A'}
--------------------------------`;
        }

        imprimirTiquete(t);
        enviarWhatsApp(reg.telefonos, t);
        res.json({ mensaje: "Ok" });
    } catch (e) { 
        console.error(e);
        res.status(500).json({ error: "Error en el servidor" }); 
    }
});

server.listen(PORT_WEB, () => console.log(`🚀 Servidor Banexport listo en puerto ${PORT_WEB}`));