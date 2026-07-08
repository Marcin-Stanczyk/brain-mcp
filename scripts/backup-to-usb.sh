#!/bin/bash
# Brain-MCP Backup Script (macOS)
# Backs up the knowledge database (and optionally your editor/agent config)
# to an external USB drive.
# Usage: ./backup-to-usb.sh [USB_VOLUME_NAME]
#   or:  BRAIN_BACKUP_VOLUME=MyDrive ./backup-to-usb.sh

set -euo pipefail

# Resolve the brain-mcp root relative to this script's location
BRAIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

USB_NAME="${1:-${BRAIN_BACKUP_VOLUME:-BACKUP}}"
USB_PATH="/Volumes/${USB_NAME}"
BACKUP_DIR="${USB_PATH}/brain-mcp-backup"
TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
DATED_DIR="${BACKUP_DIR}/${TIMESTAMP}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Brain-MCP Backup Script${NC}"
echo "=========================="

# Check USB mounted
if [ ! -d "$USB_PATH" ]; then
    echo -e "${RED}USB drive '${USB_NAME}' not found at ${USB_PATH}${NC}"
    echo "Available volumes:"
    ls /Volumes/
    echo ""
    echo "Usage: $0 YOUR_DRIVE_NAME"
    exit 1
fi

echo -e "${GREEN}USB drive found: ${USB_PATH}${NC}"

# Create backup directory
mkdir -p "$DATED_DIR"

# 1. Brain-MCP database (most critical)
echo "Backing up brain-mcp database..."
cp "$BRAIN_DIR/data/knowledge.db" "$DATED_DIR/knowledge.db"
# Also copy WAL if it exists (for consistency)
[ -f "$BRAIN_DIR/data/knowledge.db-wal" ] && cp "$BRAIN_DIR/data/knowledge.db-wal" "$DATED_DIR/knowledge.db-wal"
[ -f "$BRAIN_DIR/data/knowledge.db-shm" ] && cp "$BRAIN_DIR/data/knowledge.db-shm" "$DATED_DIR/knowledge.db-shm"

# 2. VS Code agent/prompt configurations (optional — skipped if absent)
echo "Backing up agent configurations..."
AGENT_DIR="$HOME/Library/Application Support/Code/User/prompts"
mkdir -p "$DATED_DIR/agents"
cp "$AGENT_DIR"/*.md "$DATED_DIR/agents/" 2>/dev/null || true

# 3. MCP server config (optional)
echo "Backing up MCP config..."
cp "$HOME/Library/Application Support/Code/User/mcp.json" "$DATED_DIR/mcp.json" 2>/dev/null || true

# 4. VS Code settings (optional)
echo "Backing up VS Code settings..."
mkdir -p "$DATED_DIR/vscode"
cp "$HOME/Library/Application Support/Code/User/settings.json" "$DATED_DIR/vscode/settings.json" 2>/dev/null || true

# 5. Copilot memory files (optional)
MEMORY_DIR="$HOME/Library/Application Support/Code/User/globalStorage/github.copilot-chat/memories"
if [ -d "$MEMORY_DIR" ]; then
    echo "Backing up memory files..."
    mkdir -p "$DATED_DIR/memories"
    cp -R "$MEMORY_DIR"/* "$DATED_DIR/memories/" 2>/dev/null || true
fi

# 6. Brain-MCP source code (for reproducibility)
echo "Backing up brain-mcp source..."
mkdir -p "$DATED_DIR/brain-mcp-src"
cp "$BRAIN_DIR/src/index.ts" "$DATED_DIR/brain-mcp-src/"
cp "$BRAIN_DIR/package.json" "$DATED_DIR/brain-mcp-src/"
cp "$BRAIN_DIR/tsconfig.json" "$DATED_DIR/brain-mcp-src/"

# Calculate backup size
BACKUP_SIZE=$(du -sh "$DATED_DIR" | cut -f1)

# Keep only the last 10 backups (rotate old ones)
cd "$BACKUP_DIR"
BACKUP_COUNT=$(ls -d 20* 2>/dev/null | wc -l | tr -d ' ')
if [ "$BACKUP_COUNT" -gt 10 ]; then
    REMOVE_COUNT=$((BACKUP_COUNT - 10))
    echo "Rotating: removing ${REMOVE_COUNT} old backup(s)..."
    ls -d 20* | head -n "$REMOVE_COUNT" | xargs rm -rf
fi

echo ""
echo -e "${GREEN}Backup complete!${NC}"
echo "   Location: ${DATED_DIR}"
echo "   Size: ${BACKUP_SIZE}"
echo "   Timestamp: ${TIMESTAMP}"
echo "   Total backups: $(ls -d ${BACKUP_DIR}/20* 2>/dev/null | wc -l | tr -d ' ')"
