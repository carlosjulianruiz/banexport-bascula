# Bascula - Sistema de Pesaje Industrial

Sistema web de gestión de pesajes para báscula industrial, diseñado para ejecutarse en Raspberry Pi. Permite registrar entradas y salidas de vehículos, calcular peso neto y enviar tiquetes automáticamente por WhatsApp.

## Requisitos

- **Node.js** >= 18
- **npm**
- (Opcional) **Raspberry Pi** con puerto serial conectado a indicador de báscula
- (Opcional) Cuenta de **Twilio** para envío de tiquetes por WhatsApp

## Instalación

```bash
git clone <repositorio>
cd bascula
npm install
```

## Ejecución

```bash
npm start
```

El servidor inicia en `http://localhost:3000`.

## Estructura del Proyecto

```
bascula/
├── server.js                 # Servidor Express + API REST + Socket.IO
├── Public/
│   └── index.html            # Frontend SPA (Tailwind CSS)
├── banexport_pesajes.db      # Base de datos SQLite (se crea automáticamente)
├── package.json
└── README.md
```

## Stack Tecnológico

| Componente    | Tecnología                          |
|---------------|-------------------------------------|
| Backend       | Node.js, Express 5                  |
| Base de datos | SQLite3                             |
| Tiempo real   | Socket.IO (lectura de peso en vivo) |
| Frontend      | HTML, Tailwind CSS, JavaScript      |
| Puerto serial | serialport (lectura de báscula)     |
| Notificaciones| Twilio (WhatsApp)                   |

## Módulos de la Aplicación

### Pesaje

Pantalla principal. Muestra el peso en vivo de la báscula y un formulario lateral para registrar operaciones.

- Al ingresar una **placa**, el sistema consulta si el vehículo tiene un pesaje abierto (ya está en planta).
- Si **no tiene pesaje abierto**: se registra una **entrada** con el peso actual.
- Si **ya tiene pesaje abierto**: se registra la **salida**, se calcula el peso neto y se cierra el tiquete.
- Autocompleta conductor y teléfonos a partir del historial de la placa.

### Historial

Tabla paginada con todos los pesajes registrados. Permite:

- Búsqueda por placa o conductor.
- Filtro por rango de fechas.
- Reimpresión y reenvío de tiquetes por WhatsApp.

### Vehículos (Maestro)

Tabla de consulta con la relación placa-conductor-teléfonos, ordenada por última actividad. Se alimenta automáticamente con cada pesaje registrado.

### Configuración

Permite editar:

- Datos de la empresa (nombre, NIT, dirección, teléfono, correo).
- Credenciales de Twilio para envío de tiquetes por WhatsApp (Account SID, Auth Token, número emisor).

## API REST

| Método | Ruta                      | Descripción                                      |
|--------|---------------------------|--------------------------------------------------|
| GET    | `/api/empresa`            | Obtener datos de la empresa                      |
| POST   | `/api/empresa`            | Actualizar datos de la empresa y credenciales    |
| GET    | `/api/vehiculo/:placa`    | Consultar estado de un vehículo por placa        |
| GET    | `/api/maestro-vehiculos`  | Listar relaciones placa-conductor                |
| GET    | `/api/historial`          | Historial paginado con filtros                   |
| POST   | `/api/registrar`          | Registrar pesaje (entrada o salida automática)   |
| POST   | `/api/reimprimir`         | Reenviar tiquete por WhatsApp                    |

### WebSocket

| Evento       | Dirección       | Descripción                              |
|--------------|-----------------|------------------------------------------|
| `peso_live`  | Servidor -> Cliente | Peso actual de la báscula (cada 500ms) |

## Base de Datos

SQLite con 3 tablas:

- **pesajes** - Registro de entradas/salidas con pesos, fechas y estado (ABIERTO/CERRADO).
- **placa_conductores** - Relación muchos a muchos entre placas y conductores con teléfonos.
- **empresa** - Datos de la empresa y credenciales Twilio (registro único).

La base de datos se crea automáticamente al iniciar el servidor por primera vez.

## Configuración de WhatsApp (Twilio)

1. Crear cuenta en [Twilio](https://www.twilio.com/).
2. Activar el Sandbox de WhatsApp en la consola de Twilio.
3. En la pestaña **Config** de la aplicación, ingresar:
   - **Account SID**
   - **Auth Token**
   - **Numero emisor** (formato `+14155238886`)

## Backup Automático a Dropbox

El proyecto incluye un script (`backup-dropbox.sh`) que realiza una copia segura de la base de datos SQLite y la sube a Dropbox usando **rclone**.

### Instalación de rclone (Raspberry Pi)

```bash
sudo apt install rclone
```

### Configurar el remote de Dropbox

```bash
rclone config
```

Seguir el wizard interactivo:

1. **New remote** -> nombre: `dropbox`
2. **Storage**: seleccionar `dropbox`
3. **client_id**: dejar vacío (Enter)
4. **client_secret**: dejar vacío (Enter)
5. **Edit advanced config?**: `n`
6. **Use auto config?**: `y`
7. Se abre el navegador -> iniciar sesión en Dropbox y autorizar el acceso
8. Si pide contraseña de keyring, elegir una y recordarla
9. Confirmar con `y`

### Probar el backup manualmente

```bash
./backup-dropbox.sh
```

Los backups se guardan en Dropbox en la carpeta `bascula-backups/`.

### Programar backup automático con cron

```bash
crontab -e
```

Agregar una línea según la frecuencia deseada:

```bash
# Cada 6 horas
0 */6 * * * /home/pi/bascula/backup-dropbox.sh

# Cada hora
0 * * * * /home/pi/bascula/backup-dropbox.sh

# Todos los días a las 11pm
0 23 * * * /home/pi/bascula/backup-dropbox.sh
```

> Ajustar la ruta al directorio real del proyecto en el Raspberry Pi.

### Retención

- **Local**: se conservan los últimos 7 backups.
- **Dropbox**: se conservan los últimos 30 backups.

## Conexión de Báscula (Puerto Serial)

El servidor importa `serialport` para leer datos del indicador de peso. Actualmente la lectura en vivo está simulada con valores aleatorios (~15000 kg). Para conectar una báscula real, se debe configurar el puerto serial y el parser en `server.js`.

## Zona Horaria

Todas las fechas se registran en zona horaria **America/Bogota** (UTC-5).
