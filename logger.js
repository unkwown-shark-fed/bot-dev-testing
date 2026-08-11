const winston = require('winston');
require('dotenv').config();
const path = require('path');
const fs = require('fs');

const logDir = path.resolve('logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logFile = process.env.LOG_FILE || 'logs/bot.log';
const errorLogFile = process.env.ERROR_LOG_FILE || 'logs/error.log';

// Custom format with colors for console
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message }) => {
    return `${timestamp} ${level}: ${message}`;
  })
);

// Clean format for files (no colors)
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message }) => {
    return `${timestamp} [${level.toUpperCase()}] ${message}`;
  })
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: [
    // Console output with colors
    new winston.transports.Console({
      format: consoleFormat
    }),

    // All logs to main file
    new winston.transports.File({
      filename: path.resolve(logFile),
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),

    // Error logs to separate file
    new winston.transports.File({
      filename: path.resolve(errorLogFile),
      level: 'error',
      format: fileFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 3
    })
  ]
});

module.exports = logger;
