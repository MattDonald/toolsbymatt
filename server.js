require("dotenv").config();
const express = require("express");
const stripe  = require("stripe")(process.env.STRIPE_SECRET_KEY);
const crypto  = require("crypto");
const axios   = require("axios");
const app     = express();

// Brevo API configuration
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_API_URL = 'https://api.brevo.com/v3';

// Axios instance for Brevo API calls
const brevoAPI = axios.create({
  baseURL: BREVO_API_URL,
  headers: {
    'api-key': BREVO_API_KEY,
    'Content-Type': 'application/json'
  }
});

// Product map: Stripe product name → array of Dropbox links
// Single products have one link in array, bundles have multiple
const PRODUCTS = {
  'tp7_stem_recorder': [process.env.PRODUCT_1_LINK],
  'tp_stem_splitter': [process.env.PRODUCT_2_LINK],
  'tp7_speed_sync': [process.env.PRODUCT_3_LINK],
  'chroma_control': [process.env.PRODUCT_4_LINK],
  'subphatty_sync': [process.env.PRODUCT_5_LINK],
  'art_tools': [process.env.PRODUCT_6_LINK],

  'tp7_tools': [
    process.env.PRODUCT_1_LINK,
    process.env.PRODUCT_2_LINK,
    process.env.PRODUCT_3_LINK,
  ],
};

// Product metadata: display name for each Dropbox link
const PRODUCT_META = {
  [process.env.PRODUCT_1_LINK]: 'tp7_stem_recorder',
  [process.env.PRODUCT_2_LINK]: 'tp_stem_splitter',
  [process.env.PRODUCT_3_LINK]: 'tp7_speed_sync',
  [process.env.PRODUCT_4_LINK]: 'chroma_control',
  [process.env.PRODUCT_5_LINK]: 'subphatty_sync',
  [process.env.PRODUCT_6_LINK]: 'art_tools',
};

// Token store: active 48-hour download tokens held in memory
const tokenStore = {};

function createToken(dropboxLink, productName) {
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + (48 * 60 * 60 * 1000);
  tokenStore[token] = { dropboxLink, expiresAt, productName };
  return token;
}

// Download route: customer clicks the link in their email
app.get("/download", (req, res) => {
  const { token } = req.query;
  const record    = tokenStore[token];
  if (!record) {
    return res.status(404).send(`
      <h2 style='font-family:Arial'>Link not found</h2>
      <p style='font-family:Arial'>This link is invalid or has expired.</p>
      <p style='font-family:Arial'>Contact store@mattdonald.com for help.</p>`);
  }
  if (Date.now() > record.expiresAt) {
    delete tokenStore[token];
    return res.status(410).send(`
      <h2 style='font-family:Arial'>Download link expired</h2>
      <p style='font-family:Arial'>This link was valid for 48 hours.</p>
      <p style='font-family:Arial'>Reply to your purchase email for a new link.</p>`);
  }
  res.redirect(record.dropboxLink);
});

// Form signup route: Readymag sends form data here
app.post("/signup", express.json(), async (req, res) => {
  const { Email } = req.body;
  const email = Email; // Readymag capitalizes field names
  
  if (!email) {
    return res.status(400).json({ error: "Email required" });
  }
  try {
    await addToSignupPendingList(email);
    console.log(`Signup submitted: ${email} — pending DOI confirmation`);
    res.json({ success: true });
  } catch (err) {
    console.error("Signup error:", err.response?.data || err.message);
    res.status(500).json({ error: "Signup failed" });
  }
});

// Webhook route: Stripe fires this after a successful payment
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook error:", err.message);
    return res.status(400).send("Webhook Error");
  }
  if (event.type === "checkout.session.completed") {
    const session     = event.data.object;
    const email       = session.customer_details?.email;
    const fullName    = session.customer_details?.name || '';
    const firstName   = fullName.split(' ')[0] || 'there';
    const lineItems   = await stripe.checkout.sessions.listLineItems(session.id);
    const productName = lineItems.data[0]?.description;
    const dropboxLink = PRODUCTS[productName];
    if (!email || !dropboxLink) {
      console.warn("Could not match product:", productName);
      return res.json({ received: true });
    }
    // Generate one token per file (bundles will have multiple)
const dropboxLinks = PRODUCTS[productName];
const downloadUrls = dropboxLinks.map((link, index) => {
  const token = createToken(link, `${productName} - File ${index + 1}`);
  return `${process.env.RENDER_URL}/download?token=${token}`;
});

await Promise.all([
  addToCustomersList(email, fullName, productName),
  sendDownloadEmail(email, firstName, productName, downloadUrls),
]);

    console.log(`Done for ${email} — ${productName}`);
  }
  res.json({ received: true });
});

// Add customer to the 'Customers' list ONLY (not Marketing Subscribers)
// If they already exist, append the new product to their PRODUCTS_PURCHASED list
async function addToCustomersList(email, fullName, productName) {
  const nameParts = fullName.split(' ');
  const firstName = nameParts[0] || '';
  const lastName  = nameParts.slice(1).join(' ') || '';

  // First, check if contact exists and get their current PRODUCTS_PURCHASED
  let existingProducts = '';
  try {
    const response = await brevoAPI.get(`/contacts/${encodeURIComponent(email)}`);
    existingProducts = response.data.attributes.PRODUCTS_PURCHASED || '';
  } catch (err) {
    // Contact doesn't exist yet, that's fine
  }

  // Build the new products list: append new product if not already present
  let updatedProducts = existingProducts;
  if (!existingProducts) {
    updatedProducts = productName;
  } else if (!existingProducts.includes(productName)) {
    updatedProducts = existingProducts + ', ' + productName;
  }

  const contactData = {
    email: email,
    listIds: [parseInt(process.env.CUSTOMERS_LIST_ID)],
    updateEnabled: true,
    attributes: {
      FIRSTNAME: firstName,
      LASTNAME: lastName,
      PRODUCTS_PURCHASED: updatedProducts,
      SOURCE: 'purchase',
    }
  };

  try {
    await brevoAPI.post('/contacts', contactData);
    console.log(`Added to Customers list: ${email} — Products: ${updatedProducts}`);
  } catch (err) {
    console.error("Brevo contact error:", err.response?.data || err.message);
  }
}

// Add signup to the temporary 'Signup Pending Confirmation' list
// Brevo automation will automatically send DOI email and move to Marketing Subscribers
async function addToSignupPendingList(email) {
  const contactData = {
    email: email,
    listIds: [parseInt(process.env.SIGNUP_PENDING_LIST_ID)],
    updateEnabled: false,
    attributes: {
      SOURCE: 'signup',
    }
  };

  try {
    await brevoAPI.post('/contacts', contactData);
    console.log(`Added to Signup Pending list: ${email}`);
  } catch (err) {
    console.error("Brevo signup error:", err.response?.data || err.message);
    throw err;
  }
}

// Send the transactional download email via Brevo template
async function sendDownloadEmail(email, firstName, productName, downloadUrls) {
  // Get the Dropbox links for this product to look up display names
  const dropboxLinks = PRODUCTS[productName];
  // Map each link to its display name from PRODUCT_META
  const productNames = dropboxLinks.map(link => PRODUCT_META[link] || productName);
  
  const emailData = {
    to: [{ email: email }],
    sender: { name: 'Matt Donald', email: process.env.BREVO_SENDER_EMAIL },
    templateId: parseInt(process.env.BREVO_TEMPLATE_ID),
    params: {
      firstName,
      productName,
      downloadUrl1: downloadUrls[0] || '',
      downloadUrl2: downloadUrls[1] || '',
      downloadUrl3: downloadUrls[2] || '',
      downloadUrl4: downloadUrls[3] || '',
      downloadUrl5: downloadUrls[4] || '',
      productName1: productNames[0] || '',
      productName2: productNames[1] || '',
      productName3: productNames[2] || '',
      productName4: productNames[3] || '',
      productName5: productNames[4] || '',
    }
  };

  try {
    await brevoAPI.post('/smtp/email', emailData);
    console.log(`Download email sent to: ${email}`);
  } catch (err) {
    console.error("Brevo email error:", err.response?.data || err.message);
  }
}

app.listen(4242, () => console.log("Server running on port 4242"));
