const Stripe = require("stripe");
const { google } = require("googleapis");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function getGoogleClient() {
  const privateKey = process.env.GOOGLE_SHEETS_PRIVATE_KEY.replace(/\\n/g, "\n");
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

module.exports = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const { name, phone, date, time, partySize, celebration } = session.metadata || {};
    const amountTotal = session.amount_total ? session.amount_total / 100 : "";

    const row = [
      new Date().toISOString(),
      name || "",
      session.customer_email || "",
      phone || "",
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
