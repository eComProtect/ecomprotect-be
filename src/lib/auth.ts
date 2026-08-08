import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { database } from "../configs/connection.config";
import * as schema from "@/schema/schema";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin as adminPlugin, bearer, emailOTP } from "better-auth/plugins";
import { env } from "@/utils/env.util";
import {
  adminApprovalNotificationTemplate,
  resetPasswordTemplate,
  staffInvitationTemplate,
  storeInvitationAcceptedTemplate,
} from "@/utils/sendgrid.util";
import { eq, sql } from "drizzle-orm";
import { ac, manager, support, admin, superadmin, owner } from "./permission";
import { decrypt, encrypt } from "@/service/encryption.service";
import { users } from "@/schema/schema";
import { sendEmail } from "@/configs/brevo.config";
import { logActivity } from "@/service/logactivity.service";

const isProduction = process.env.NODE_ENV === "production";

const normalizeEmail = (email: unknown) =>
  typeof email === "string" ? email.trim() : "";

const findUserByEmail = async (email: string) => {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    return null;
  }

  return database.query.users.findFirst({
    where: sql`lower(${users.email}) = ${normalizedEmail.toLowerCase()}`,
  });
};

export const auth = betterAuth({
  database: drizzleAdapter(database, { provider: "pg", schema }),
  secret: env.COOKIE_SECRET,
  trustedOrigins: [env.FRONTEND_DOMAIN],

  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24, // 1 day( "expiresIn = now + expiry" after every updateAge time, if session is used )
    cookieCache: {
      enabled: true, // Enable caching session in cookie
      maxAge: 5 * 60, // 5 minutes
    },
  },

  advanced: {
    useSecureCookies: isProduction, // required for HTTPS domains
    cookies: {
      session_token: {
        attributes: {
          sameSite: isProduction ? "none" : "lax", // 'lax' for dev, 'none' for prod
          httpOnly: isProduction, // false for dev, true for prod
          secure: isProduction, // false for dev, true for prod
        },
      },
    },
  },

  plugins: [
    // Lets a session token be sent as `Authorization: Bearer <token>` instead of
    // a cookie. Needed for the embedded staff-identity flow: Shopify Admin's
    // iframe blocks third-party cookies, so a staff member's own login can't
    // rely on a cookie there — see x-staff-token handling in auth.middleware.ts.
    bearer(),
    adminPlugin({
      adminRoles: ["admin", "superadmin"],
      ac,
      roles: {
        admin,
        superadmin,
        manager,
        support,
        owner,
      },
    }),
    emailOTP({
      async sendVerificationOTP({ email, otp }) {
        try {
          const user = await findUserByEmail(email);
          const recipientEmail = user?.email ?? normalizeEmail(email);

          let emailSubject = "";
          let emailHtml = "";
          let userName = recipientEmail.split("@")[0];

          if (user && (user.role === "owner" || user.role === "subadmin")) {
            emailSubject = "Welcome! Please Verify Your Store's Email";
            userName = user.name || userName; // Use their actual name if available
            emailHtml = storeInvitationAcceptedTemplate({
              staffName: userName,
              staffEmail: recipientEmail,
              dashboardLink: `${env.FRONTEND_DOMAIN}/verify-store?email=${encodeURIComponent(
                recipientEmail
              )}&otp=${encodeURIComponent(otp)}`,
              companyName: "eComProtect",
            });
          } else {
            emailSubject = "You're Invited to Join Your Team!";
            emailHtml = staffInvitationTemplate({
              staffName: userName,
              staffEmail: recipientEmail,
              invitationLink: `${env.FRONTEND_DOMAIN}/accept-invite?email=${encodeURIComponent(
                recipientEmail
              )}&otp=${encodeURIComponent(otp)}`,
              companyName: "eComProtect", // You could even make this dynamic by looking up the store they belong to
            });
          }

          // --- Step 3: Construct and send the email ---
          const msg = {
            to: recipientEmail,
            subject: emailSubject,
            htmlContent: emailHtml,
          };

          await sendEmail(msg);
          console.log(
            `Successfully sent '${emailSubject}' email to ${recipientEmail} via SendGrid.`
          );
        } catch (error) {
          console.error("Failed to send verification email:", error);
          throw new Error("Failed to send verification email.");
        }
      },
    }),
  ],

  emailAndPassword: {
    sendResetPassword: async ({ token, user }: any) => {
      try {
        const resetLink = `${env.FRONTEND_DOMAIN}/reset-password?token=${token}`;

        console.log(user);

        const emailSubject = "Your Password Reset Request";

        // Generate dynamic user name for the template
        const userName = user.name || (user.email ? user.email.split("@")[0] : "User");

        // Generate the HTML content using your template function
        const emailHtml = resetPasswordTemplate({
          resetLink: resetLink,
          userName: userName,
        });

        // --- Replace SendGrid logic with your Brevo/Nodemailer utility ---
        const emailSent = await sendEmail({
          to: user.email,
          subject: emailSubject,
          htmlContent: emailHtml,
          // The 'from' address is handled by your sendEmail utility's defaults or your ENV.
          // You can explicitly set it here if needed, but using the default is cleaner.
          // from: `"${env.BREVO_SENDER_NAME}" <${env.BREVO_SENDER_EMAIL}>` 
        });

        if (emailSent) {
          console.log("Successfully sent password reset email via Brevo/Nodemailer.");
        } else {
          // The sendEmail utility already handles internal logging for failure, 
          // but we'll re-throw for the caller to handle.
          throw new Error("Email sending failed according to utility.");
        }
      } catch (error) {
        console.error("Failed to send password reset email:", error);
        throw new Error("Failed to send password reset email.");
      }
    },
    // requireEmailVerification: true,
    // maxPasswordLength: 10,
    // minPasswordLength: 8,
    // autoSignIn: true,

    enabled: true,
  },

  emailVerification: {
    sendVerificationEmail: async ({
      user,
      url,
    }: {
      user: any;
      url: string;
    }) => {
      const autoActivation = process.env.AUTO_ACTIVATION === "true";

      if (autoActivation) {
        await database
          .update(schema.users)
          .set({ emailVerified: true })
          .where(eq(schema.users.id, user.id));

        return;
      }

      const approvalLink = url;
      const subscriptionPlan = user.package || "Not Specified";
      const userName = user.name || user.email.split("@")[0];
      const userEmail = user.email;
      const companyName = user.company_name || "Not Provided";
      const shopifyUrl = user.shopify_url || "Not Provided";
      const companyRegistrationNumber =
        user.company_registration_number || "Not Provided";
      const averageOrdersPerMonth =
        user.average_orders_per_month || "Not Provided";

      // --- HTML content generation ---
      const emailHtml = adminApprovalNotificationTemplate({
        userName,
        userEmail,
        companyName,
        shopifyUrl,
        companyRegistrationNumber,
        averageOrdersPerMonth,
        subscriptionPlan,
        approvalLink,
      });

      const emailSubject = "New User Registration - Approval Required";

      // --- Replace SendGrid logic with your Brevo/Nodemailer utility ---
      try {
        const emailSent = await sendEmail({
          to: env.ADMIN_EMAIL!, // The recipient is the admin's email
          subject: emailSubject,
          htmlContent: emailHtml,
          // The 'from' address is handled by your sendEmail utility's defaults or your ENV.
        });

        if (emailSent) {
          console.log(
            `Successfully sent '${emailSubject}' email to ${env.ADMIN_EMAIL!} via Brevo/Nodemailer.`
          );
        } else {
          throw new Error("Email sending failed according to utility.");
        }
      } catch (error) {
        console.error("Failed to send admin approval email:", error);
        throw new Error("Failed to send admin approval email.");
      }
    },
    // autoSignInAfterVerification: true,
    sendOnSignUp: false,
  },

  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-in/email") {
        const submittedEmail = normalizeEmail(ctx.body.email);
        ctx.body.email = submittedEmail;

        const existing = await findUserByEmail(submittedEmail);

        if (existing) {
          ctx.body.email = existing.email;
        }

        if (existing && !existing.emailVerified) {
          throw new APIError("FORBIDDEN", {
            message: "Only verified users can signin!",
          });
        }
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      // Staff creation (Create Staff page → authClient.admin.createUser) goes
      // straight through better-auth's admin plugin — no custom controller
      // exists for it, so this was the only place to log it at all.
      if (ctx.path === "/admin/create-user") {
        try {
          const createdEmail = normalizeEmail(ctx.body?.email);
          const createdUser = createdEmail
            ? await findUserByEmail(createdEmail)
            : null;

          if (createdUser) {
            await logActivity({
              action: "STAFF_INVITED",
              for: "store",
              storeId: createdUser.storeOwnerId ?? createdUser.id,
              meta: {
                invitedEmail: createdUser.email,
                role: createdUser.role,
                invitedBy: ctx.context.session?.user?.id ?? null,
              },
            });
          }
        } catch (err) {
          console.error("Failed to log STAFF_INVITED activity:", err);
        }
      }

      // Staff accepting their invite verifies their email via the emailOTP
      // plugin (see acceptinvitation.page.tsx). Guarded to role !== "owner"
      // since this same endpoint could in principle verify any account.
      if (ctx.path === "/email-otp/verify-email") {
        try {
          const verifiedEmail = normalizeEmail(ctx.body?.email);
          const verifiedUser = verifiedEmail
            ? await findUserByEmail(verifiedEmail)
            : null;

          if (verifiedUser?.emailVerified && verifiedUser.role !== "owner") {
            await logActivity({
              action: "STAFF_JOINED",
              for: "store",
              storeId: verifiedUser.storeOwnerId ?? verifiedUser.id,
              meta: { email: verifiedUser.email, role: verifiedUser.role },
            });
          }
        } catch (err) {
          console.error("Failed to log STAFF_JOINED activity:", err);
        }
      }
    }),
  },

  user: {
    modelName: "users",
    additionalFields: {
      company_name: {
        type: "string",
        required: false,
        fieldName: "company_name",
        returned: true,
      },
      mobile_number: {
        type: "string",
        required: false,
        fieldName: "mobile_number",
        returned: true,
      },
      company_registration_number: {
        type: "string",
        required: false,
        fieldName: "company_registration_number",
        returned: true,
      },
      average_orders_per_month: {
        type: "string",
        required: false,
        fieldName: "average_orders_per_month",
        returned: true,
      },
      plan: {
        type: "string",
        required: false,
        fieldName: "plan",
        returned: true,
      },
      package: {
        type: "string",
        required: false,
        fieldName: "package",
        returned: true,
      },
      shopify_api_key: {
        type: "string",
        required: false,
        fieldName: "shopify_api_key",
        returned: true,
        // Deliberately no encrypt/decrypt transform — unlike
        // shopify_access_token, this is our own public app Client ID
        // (env.SHOPIFY_API_KEY), stored as plaintext everywhere it's
        // written (shopify.route.ts, auth.middleware.ts) and looked up by
        // exact-match in findUserByApiKey, which requires it to stay
        // plaintext. The encrypt/decrypt pair here was a copy-paste
        // artifact from the field below — decrypting an already-plaintext
        // value threw "Malformed UTF-8 data" on every session lookup.
      },
      shopify_access_token: {
        type: "string",
        required: false,
        fieldName: "shopify_access_token",
        returned: true,
        transform: {
          input: (val) => (typeof val === "string" ? encrypt(val) : val),
          output: (val) => (typeof val === "string" ? decrypt(val) : val),
        },
      },
      shopify_url: {
        type: "string",
        required: false,
        fieldName: "shopify_url",
        returned: true,
      },
      role: {
        type: "string",
        required: false,
        fieldName: "role",
        returned: true,
      },
      storeOwnerId: {
        type: "string",
        required: false,
        fieldName: "storeOwnerId",
        returned: true,
      },
      // Missing here meant better-auth's own session.user object (returned
      // via getSession — the x-staff-token path in resolveRequestUser, and
      // the plain cookie-session fallback) never carried onboardingStatus at
      // all, unlike the raw Drizzle row findUserByShopDomain/
      // findUserBySessionToken return for the App Bridge Bearer-token path.
      // resolveStoreRow's storeOwnerId-null short-circuit then returned that
      // incomplete object as-is, so requireActiveOnboarding read
      // store.onboardingStatus as undefined and 403'd with
      // onboardingStatus:null on every request — even for the real, active
      // owner — the instant a session ever got resolved via getSession
      // instead of the Bearer path (i.e. right after any manual /signin).
      onboardingStatus: {
        type: "string",
        required: false,
        fieldName: "onboardingStatus",
        returned: true,
      },
      // Same class of bug as onboardingStatus above: when a request resolves
      // via getSession (the x-staff-token path, or the plain cookie fallback
      // right after any manual /signin), resolveStoreRow returns better-auth's
      // session.user object as-is for an owner (storeOwnerId null). Without
      // this field declared, shopify_token_expires_at was undefined on that
      // object, so resolveStoreShopifyAccess saw isShopifyTokenExpired(undefined)
      // === true and fired attemptTokenMigration on a perfectly valid modern
      // expiring token — which Shopify rejects with a 400 — 401ing every
      // /customer, /order etc. call and forcing an endless re-auth/reinstall
      // loop ("could not load"). Declaring it means the session object carries
      // the real expiry and expiry checks operate on the true value.
      shopify_token_expires_at: {
        type: "date",
        required: false,
        fieldName: "shopify_token_expires_at",
        returned: true,
      },
    },
    changeEmail: {
      enabled: true,
      sendChangeEmailVerification: async () => {
        // Send change email verification
      },
    },
    deleteUser: {
      enabled: true,
      sendDeleteAccountVerification: async () => {
        // Send delete account verification
      },
      beforeDelete: async () => {
        // Perform actions before user deletion
      },
      afterDelete: async () => {
        // Perform cleanup after user deletion
      },
    },
  },
});
