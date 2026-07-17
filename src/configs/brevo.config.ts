import nodemailer from "nodemailer";
import BrevoTransport from "nodemailer-brevo-transport";
import { env } from "../utils/env.util";
import { logger } from "../utils/logger.util";



export interface SendEmailOptions {
    to: string;
    subject: string;
    htmlContent: string;
    textContent?: string;
    from?: string;
}



export const sendEmail = async (
    options: SendEmailOptions
): Promise<boolean> => {
    try {

        const apiKey = env.BREVO_API_KEY || process.env.BREVO_API_KEY;
        if (!apiKey) {
            logger.warn(
                "BREVO_API_KEY not configured. Email not sent. Set BREVO_API_KEY in .env to enable."
            );
            return false;
        }
        // Create transporter using Brevo transport
        const transport = nodemailer.createTransport(
            new BrevoTransport({ apiKey })
        );
        
        // Send email
        console.log("Brevo Email:", env.BREVO_EMAIL);
        console.log("PROCESS ENV EMAIL:", process.env.BREVO_EMAIL);

        const data = await transport.sendMail({
            from: env.BREVO_EMAIL,
            to: options.to,
            subject: options.subject,
            html: options.htmlContent,
            text: options.textContent,
        });

        logger.info(
            `Email sent successfully to ${options.to}. Message ID: ${data.messageId || "unknown"
            }`
        );
        return true;
    } catch (error: unknown) {
        // Pino only interpolates trailing string args into %s/%d
        // placeholders — a bare string with no placeholder is silently
        // dropped, which is why this used to log nothing after the colon.
        // Passing the error as a merging object keeps the full message,
        // stack, and any Brevo response body in the output.
        logger.error(
            { err: error, brevoResponse: (error as any)?.response?.body },
            `Failed to send email to ${options.to}`
        );
        return false;
    }
};