import winston from "winston";
import { WinstonModuleOptions } from "nest-winston";

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: "HH:mm:ss" }),
  errors({ stack: true }),
  printf(({ level, message, timestamp, context, stack }) => {
    const ctx = context ? ` [${context}]` : "";
    return `${timestamp} ${level}${ctx}: ${message}${stack ? `\n${stack}` : ""}`;
  }),
);

const prodFormat = combine(timestamp(), errors({ stack: true }), json());

export const winstonConfig: WinstonModuleOptions = {
  transports: [
    new winston.transports.Console({
      format: process.env.NODE_ENV === "production" ? prodFormat : devFormat,
      silent: process.env.NODE_ENV === "test",
    }),
  ],
};
