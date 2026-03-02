const Stripe = require("stripe");
const { google } = require("googleapis");
const { Resend } = require("resend");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function getGoogleClient() {
  const rawKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY || "";
  const normalized = rawKey.replace(/\\n/g, "\n").replace(/\r/g, "").trim();
  const privateKey = normalized.includes("BEGIN PRIVATE KEY")
    ? normalized
    : Buffer.from(normalized, "base64").toString("utf8");
  const auth = new google.auth.JWT(
    process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
    null,
    privateKey,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return google.sheets({ version: "v4", auth });
}

async function appendToSheet(values) {
  const sheets = getGoogleClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID,
    range: `${process.env.GOOGLE_SHEETS_SHEET_NAME}!A:Z`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [values] }
  });
}

async function sendConfirmationEmail({
  to,
  name,
  date,
  time,
  partySize,
  celebration,
  amountTotal
}) {
  const from = process.env.RESEND_FROM || "Per Due <reservations@per-due.la>";
  const subject = "Your reservation is confirmed";
  const greeting = name ? `Hi ${name},` : "Hi there,";
  const html = `
    <div style="font-family: Inter, Arial, sans-serif; color:#111;">
      <h2 style="margin:0 0 12px;">Reservation confirmed</h2>
      <p style="margin:0 0 12px;">${greeting}</p>
      <p style="margin:0 0 12px;">We’re looking forward to welcoming you at Per Due. Here are your details:</p>
      <ul style="margin:0 0 12px; padding-left:16px;">
        <li><strong>Date:</strong> ${date || "—"}</li>
        <li><strong>Time:</strong> ${time || "—"}</li>
        <li><strong>Guests:</strong> ${partySize || "2"}</li>
        <li><strong>Deposit:</strong> $${amountTotal}</li>
        <li><strong>Note:</strong> ${celebration || "—"}</li>
      </ul>
      <p style="margin:0 0 12px;"><strong>Address:</strong> 8875 Cattaraugus Ave, Los Angeles, CA 90034</p>
      <p style="margin:0 0 12px;"><strong>Parking:</strong> Street parking is available along the block.</p>
      <p style="margin:0 0 12px;"><strong>Cancellation policy:</strong> Deposits are non‑refundable within 24 hours of your reservation.</p>
      <p style="margin:0 0 12px;">If you need to make changes, reply to this email.</p>
      <p style="margin:0;">Warmly,</p>
      <p style="margin:0;">Per Due</p>
    </div>
  `;

  await resend.emails.send({
    from,
    to,
    subject,
    html
  });
}

module.exports = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  const rawBody = await readRawBody(req);

  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { name, date, time, partySize, celebration } = session.metadata || {};
    const amountTotal = session.amount_total ? session.amount_total / 100 : "";

    const recipient = session.customer_email || session.customer_details?.email;
    if (!recipient) {
      throw new Error("Missing customer email on checkout session.");
    }

    await sendConfirmationEmail({
      to: recipient,
      name,
      date,
      time,
      partySize,
      celebration,
      amountTotal
    });

    const row = [
      new Date().toISOString(),
      name || "",
      session.customer_email || "",
      date || "",
      time || "",
      partySize || "",
      celebration || "",
      amountTotal,
      session.id,
      session.payment_intent || ""
    ];

    await appendToSheet(row);
  }

  res.json({ received: true });
};
