const Stripe = require("stripe");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const ALLOWED_TIMES = ["18:30", "20:30"]; // 6:30pm, 8:30pm
const ALLOWED_DAYS = [5, 6, 0]; // Fri=5, Sat=6, Sun=0

function isAllowedDate(dateStr) {
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return false;
  const day = date.getDay();
  return ALLOWED_DAYS.includes(day);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  const origin = req.headers.origin;
  const allowed = new Set(["https://per-due.la", "https://www.per-due.la"]);
  if (origin && allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const rawBody = await readRawBody(req);
  let body = {};
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const { name, email, date, time, partySize, celebration } = body || {};

  if (!name || !email || !date || !time || !partySize) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const party = Number(partySize);
  if (party !== 2) {
    return res.status(400).json({ error: "Party size must be 2" });
  }

  if (!isAllowedDate(date)) {
    return res.status(400).json({ error: "Date must be Fri, Sat, or Sun" });
  }

  if (!ALLOWED_TIMES.includes(time)) {
    return res.status(400).json({ error: "Time must be 18:30 or 20:30" });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: email,
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: "Reservation Deposit",
            description: "per due (x2 guests)"
          },
          unit_amount: 5000
        },
        quantity: 1
      }
    ],
    metadata: { name, date, time, partySize: String(party), celebration: celebration || "" },
    success_url: `${process.env.BASE_URL}/reservation-confirmed?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.BASE_URL}/reservation-canceled`
  });

  res.status(200).json({ url: session.url });
};
