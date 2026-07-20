import { database } from "@/configs/connection.config";
import { customers, orders, fulfillmentOrders } from "@/schema/schema";
import { logActivity } from "@/service/logactivity.service";
import { logger } from "@/utils/logger.util";
import { format } from "date-fns";
import { eq, desc, count, or, and } from "drizzle-orm";
import { Request, Response } from "express";
import status from "http-status";
import puppeteer from "puppeteer";
import { resolveStoreRow } from "@/middlewares/auth.middleware";

function maskEmail(email: string | null | undefined): string {
  if (!email) return "N/A";
  const parts = email.split("@");
  if (parts.length !== 2) return email;
  const name = parts[0];
  const domain = parts[1];

  const maskedName =
    name.length > 2 ? name.substring(0, 2) + "****" : name + "****";
  return `${maskedName}@${domain}`;
}

function generateReportHTML(reportData: any[]) {
  const tableRows = reportData
    .map((d) => {
      const address = d.latestAddress
        ? [d.latestAddress.city, d.latestAddress.zip, d.latestAddress.country]
            .filter(Boolean)
            .join(", ")
        : "N/A";

      return `
            <tr>
                <td>${maskEmail(d.email)}</td>
                <td>${address}</td>
                <td style="text-align: center;">${d.flaggedAttempts}</td>
                <td>${
                  d.lastAttemptDate
                    ? format(new Date(d.lastAttemptDate), "MMM dd, yyyy HH:mm")
                    : "N/A"
                }</td>
            </tr>
        `;
    })
    .join("");

  return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>High-Risk Customer Activity Report</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #333; margin: 40px; }
                .header { border-bottom: 2px solid #eee; padding-bottom: 10px; margin-bottom: 30px; }
                h1 { font-size: 28px; margin: 0; color: #dc2626; }
                p { font-size: 12px; color: #777; margin: 4px 0 0; }
                .summary { margin-bottom: 20px; font-size: 14px; }

                table { width: 100%; border-collapse: collapse; margin-top: 20px; }
                th, td { padding: 12px; border-bottom: 1px solid #eee; text-align: left; font-size: 14px; }
                th { background-color: #f8f9fa; font-weight: 600; color: #495057; border-top: 1px solid #dee2e6; }
                tr:nth-child(even) { background-color: #fcfcfc; }
                .no-data { text-align: center; padding: 40px; color: #777; font-style: italic; }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>High-Risk Customer Activity Report</h1>
                <p>Generated on: ${format(new Date(), "yyyy-MM-dd HH:mm")}</p>
            </div>

            <div class="summary">
                <p><strong>Purpose:</strong> Highlight repeat high-risk customers interacting with the store.</p>
                <p><strong>Total High-Risk Customers found:</strong> ${
                  reportData.length
                }</p>
            </div>

            ${
              reportData.length === 0
                ? '<div class="no-data">No high-risk customer activity found.</div>'
                : `
            <table>
                <thead>
                    <tr>
                        <th>Customer (Masked Email)</th>
                        <th>Last Known Location</th>
                        <th style="text-align: center;">Flagged Attempts</th>
                        <th>Last Attempt Date</th>
                    </tr>
                </thead>
                <tbody>
                    ${tableRows}
                </tbody>
            </table>
            `
            }
        </body>
        </html>
    `;
}

/** Shared data query used by both the JSON (table) and PDF (download) endpoints. */
async function fetchHighRiskActivityData(storeId: string) {
  const flaggedCustomers = await database
    .select({
      id: customers.id,
      email: customers.email,
      riskySience: customers.riskySince,
    })
    .from(customers)
    .where(and(eq(customers.flagged, true), eq(customers.storeId, storeId)));

  const finalReportData = await Promise.all(
    flaggedCustomers.map(async (customer) => {
      // A. Count Flagged Attempts (Orders that were flagged or auto-cancelled)
      const [attemptsResult] = await database
        .select({ count: count() })
        .from(orders)
        .where(
          and(
            eq(orders.customerId, customer.id),
            or(eq(orders.flagged, true), eq(orders.autoCancel, true)),
          ),
        );

      const [lastOrderDetails] = await database
        .select({
          createdAt: orders.createdAt,
          city: fulfillmentOrders.destCity,
          zip: fulfillmentOrders.destZip,
          country: fulfillmentOrders.destCountry,
        })
        .from(orders)
        .leftJoin(fulfillmentOrders, eq(orders.id, fulfillmentOrders.orderId))
        .where(eq(orders.customerId, customer.id))
        .orderBy(desc(orders.createdAt))
        .limit(1);

      return {
        customerId: customer.id,
        email: customer.email,
        flaggedAttempts: attemptsResult?.count ?? 0,
        lastAttemptDate: lastOrderDetails?.createdAt ?? null,
        latestAddress: lastOrderDetails
          ? {
            city: lastOrderDetails.city,
            zip: lastOrderDetails.zip,
            country: lastOrderDetails.country,
          }
          : null,
      };
    }),
  );

  finalReportData.sort((a, b) => {
    const dateA = a.lastAttemptDate ? new Date(a.lastAttemptDate).getTime() : 0;
    const dateB = b.lastAttemptDate ? new Date(b.lastAttemptDate).getTime() : 0;
    return dateB - dateA;
  });

  return finalReportData;
}

/**
 * GET /api/reports/high-risk-csutomer-report
 * JSON data for the on-page High-Risk Activity table (usefetchriskycustomer.ts).
 */
export const getHighRiskActivityReport = async (
  req: Request,
  res: Response,
) => {
  try {
    if (!req.user) {
      res.status(status.BAD_REQUEST).json({ message: "Not a valid user!" });
      logger.error("Not a valid user!");
      return;
    }

    // Flagged customers belong to the store (owner row), not whichever
    // staff member is asking.
    const store = await resolveStoreRow(req.user);
    if (!store) {
      res.status(status.BAD_REQUEST).json({ message: "Not a valid user!" });
      logger.error("Not a valid user!");
      return;
    }

    const finalReportData = await fetchHighRiskActivityData(store.id);

    console.log(
      `Data fetched. Found ${finalReportData.length} high-risk customers.`,
    );

    res.status(status.OK).json({
      success: true,
      data: finalReportData,
    });
  } catch (error: any) {
    console.error(
      "ERROR: Failed to fetch High-Risk Activity report data:",
      error,
    );
    res.status(status.INTERNAL_SERVER_ERROR).send({
      message: "Could not fetch the report.",
      error: error.message,
    });
  }
};

/**
 * GET /api/reports/high-risk-csutomer-report/pdf
 * PDF download for the "Download Customer Activity" button (suspiciousorder.tsx).
 * Kept on a separate route from the JSON endpoint above — both were previously
 * the same route, which meant one broke the other depending on which content
 * type it returned.
 */
export const getHighRiskActivityReportPdf = async (
  req: Request,
  res: Response,
) => {
  try {
    if (!req.user) {
      res.status(status.BAD_REQUEST).json({ message: "Not a valid user!" });
      logger.error("Not a valid user!");
      return;
    }

    const store = await resolveStoreRow(req.user);
    if (!store) {
      res.status(status.BAD_REQUEST).json({ message: "Not a valid user!" });
      logger.error("Not a valid user!");
      return;
    }

    const finalReportData = await fetchHighRiskActivityData(store.id);

    const htmlContent = generateReportHTML(finalReportData);

    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 1600 });
    await page.setContent(htmlContent, { waitUntil: "networkidle0" });

    await new Promise((resolve) => setTimeout(resolve, 500));

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "20px",
        bottom: "40px",
        left: "20px",
        right: "20px",
      },
    });
    await browser.close();

    const fileName = `HighRisk_Activity_Report_${format(
      new Date(),
      "yyyyMMdd",
    )}.pdf`;

    await logActivity({
      action: "GENERATE_REPORT",
      for: "store",
      storeId: store.id,
      meta: { timestamp: new Date().toISOString() },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(pdfBuffer);
  } catch (error: any) {
    console.error(
      "ERROR: Failed to generate High-Risk Activity PDF report:",
      error,
    );
    res.status(status.INTERNAL_SERVER_ERROR).send({
      message: "Could not generate the report.",
      error: error.message,
    });
  }
};
