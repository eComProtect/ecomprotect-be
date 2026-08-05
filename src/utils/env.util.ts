import { logger } from "./logger.util";
import { config } from "dotenv";
import { z } from "zod";
config();

const schemaObject = z.object({
  CLOUDINARY_API_SECRET: z.string(),
  CLOUDINARY_CLOUD_NAME: z.string(),
  GOOGLE_CLIENT_SECRET: z.string(),
  BETTER_AUTH_SECRET: z.string(),
  CLOUDINARY_API_KEY: z.string(),
  GOOGLE_CLIENT_ID: z.string(),
  // BETTER_AUTH_URL: z.string(),
  FRONTEND_DOMAIN: z.string(),
  CONNECTION_URL: z.string(),
  BACKEND_DOMAIN: z.string(),
  COOKIE_SECRET: z.string(),

  SENDGRID_API_KEY: z.string(),
  SENDGRID_SENDER_NAME: z.string(),
  SENDGRID_SENDER_EMAIL: z.string(),
  
  BREVO_EMAIL: z.string(),
  BREVO_API_KEY: z.string(),

  JWT_SECRET: z.string(),
  
  DATABASE_NAME: z.string(),

  ADMIN_EMAIL: z.string(),
  
  ENCRYPTION_KEY: z.string(),

  SHOPIFY_API_KEY: z.string(),
  SHOPIFY_API_SECRET: z.string(),
  SHOPIFY_APP_URL: z.string(),
});

const envSchema = schemaObject.safeParse(process.env);

if (!envSchema.success) {
  const message = `Invalid environment variables: ${JSON.stringify(
    envSchema.error.format(),
    null,
    4
  )}`;

  logger.error(message);
  throw new Error(message);
}

export const env = envSchema.data;
