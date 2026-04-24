'use strict';

const fs = require('node:fs');
const path = require('node:path');

function serializeMeta(meta) {
  if (meta === undefined || meta === null) {
    return '';
  }

  try {
    return ` ${JSON.stringify(meta)}`;
  } catch (error) {
    return ` [Unserializable Object]`;
  }
}

function createLogger(logFilePath) {
  let stream = null;
  
  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    stream = fs.createWriteStream(logFilePath, { flags: 'a' });
    stream.on('error', (err) => {
      console.error('Logger stream error:', err.message);
      stream = null;
    });
  } catch (err) {
    console.error('Failed to initialize file logger:', err.message);
  }

  function write(level, message, meta) {
    const line = `${new Date().toISOString()} [${level}] ${message}${serializeMeta(meta)}\n`;
    
    if (stream && !stream.destroyed) {
      try {
        stream.write(line);
      } catch (err) {
        console.error('Failed to write to log stream:', err.message);
      }
    }

    if (level === 'ERROR') {
      console.error(line.trim());
      return;
    }

    if (level === 'WARN') {
      console.warn(line.trim());
      return;
    }

    console.log(line.trim());
  }

  return {
    info(message, meta) {
      write('INFO', message, meta);
    },
    warn(message, meta) {
      write('WARN', message, meta);
    },
    error(message, meta) {
      write('ERROR', message, meta);
    },
    close() {
      if (stream && !stream.destroyed) {
        stream.end();
      }
    }
  };
}

module.exports = {
  createLogger
};
