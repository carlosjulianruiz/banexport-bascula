#!/bin/bash
# Backup seguro de la base de datos SQLite a Dropbox via rclone
# Uso: ./backup-dropbox.sh
# Requiere: rclone configurado con un remote llamado "dropbox"

DB_PATH="$(dirname "$0")/banexport_pesajes.db"
BACKUP_DIR="$(dirname "$0")/backups"
REMOTE="dropbox:bascula-backups"
TIMESTAMP=$(date +"%Y-%m-%d_%H%M%S")
BACKUP_FILE="banexport_pesajes_${TIMESTAMP}.db"

mkdir -p "$BACKUP_DIR"

# Copia segura usando el comando .backup de SQLite (evita corrupción por escrituras concurrentes)
sqlite3 "$DB_PATH" ".backup '${BACKUP_DIR}/${BACKUP_FILE}'"

if [ $? -ne 0 ]; then
    echo "$(date) - ERROR: Fallo al crear backup local" >> "${BACKUP_DIR}/backup.log"
    exit 1
fi

# Subir a Dropbox
rclone copy "${BACKUP_DIR}/${BACKUP_FILE}" "$REMOTE"

if [ $? -eq 0 ]; then
    echo "$(date) - OK: ${BACKUP_FILE} subido a Dropbox" >> "${BACKUP_DIR}/backup.log"
    # Mantener solo los últimos 7 backups locales
    ls -t "${BACKUP_DIR}"/banexport_pesajes_*.db | tail -n +8 | xargs rm -f 2>/dev/null
    # Mantener solo los últimos 30 backups en Dropbox
    rclone lsf "$REMOTE" --files-only | sort | head -n -30 | while read f; do
        rclone deletefile "${REMOTE}/${f}"
    done
else
    echo "$(date) - ERROR: Fallo al subir a Dropbox" >> "${BACKUP_DIR}/backup.log"
    exit 1
fi
