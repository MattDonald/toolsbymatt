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
  'free_sample_pack': [process.env.FREE_PRODUCT_LINK],
};

// Product metadata: display name for each Dropbox link
const PRODUCT_META = {
  [process.env.PRODUCT_1_LINK]: 'tp7_stem_recorder',
  [process.env.PRODUCT_2_LINK]: 'tp_stem_splitter',
  [process.env.PRODUCT_3_LINK]: 'tp7_speed_sync',
  [process.env.PRODUCT_4_LINK]: 'chroma_control',
  [process.env.PRODUCT_5_LINK]: 'subphatty_sync',
  [process.env.PRODUCT_6_LINK]: 'art_tools',
  [process.env.FREE_PRODUCT_LINK]: 'free_sample_pack',
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
    return res.redirect('https://tools.mattdonald.com/download-expired');
  }
  if (Date.now() > record.expiresAt) {
    delete tokenStore[token];
    return res.redirect('https://tools.mattdonald.com/download-expired');
  }
  res.redirect(record.dropboxLink);
});

// Form signup route: Readymag sends form data here for marketing list only
app.post("/signup", express.urlencoded({ extended: true }), express.json(), async (req, res) => {
  console.log("Signup request body:", req.body);
  
  // Readymag sends data in a weird nested format
  let emailAddress;
  
  // Try standard formats first
  emailAddress = req.body.Email || req.body.email;
  
  // Try Readymag's nested format
  if (!emailAddress && req.body['0']) {
    emailAddress = req.body['0'].email || req.body['0'].Email;
  }
  
  if (!emailAddress) {
    console.error("No email found in request:", req.body);
    return res.status(400).json({ error: "Email required" });
  }
  
  try {
    await addToSignupPendingList(emailAddress);
    console.log(`Signup submitted: ${emailAddress} — pending DOI confirmation`);
    res.json({ success: true });
  } catch (err) {
    console.error("Signup error:", err.response?.data || err.message);
    res.status(500).json({ error: "Signup failed" });
  }
});

// Free product route: Readymag form for free download with marketing consent
app.post("/free-product", express.urlencoded({ extended: true }), express.json(), async (req, res) => {
  console.log("Free product request body:", req.body);
  
  // Extract email from Readymag's nested format
  let emailAddress;
  emailAddress = req.body.Email || req.body.email;
  if (!emailAddress && req.body['0']) {
    emailAddress = req.body['0'].email || req.body['0'].Email;
  }
  
  if (!emailAddress) {
    console.error("No email found in free product request:", req.body);
    return res.status(400).json({ error: "Email required" });
  }
  
  // Respond immediately
  res.json({ success: true });
  
  // Free product details
  const freeProductName = 'free_sample_pack';
  const dropboxLinks = PRODUCTS[freeProductName];
  
  if (!dropboxLinks) {
    console.error("Free product not configured:", freeProductName);
    return;
  }
  
  // Generate download token (48 hour expiry)
  const downloadUrls = dropboxLinks.map((link, index) => {
    const token = createToken(link, `${freeProductName} - File ${index + 1}`);
    return `${process.env.RENDER_URL}/download?token=${token}`;
  });
  
  const productNames = dropboxLinks.map(link => PRODUCT_META[link] || freeProductName);
  
  // Add to BOTH lists: Customers (with free product) AND Marketing Subscribers (with consent)
  await Promise.all([
    addToCustomersList(emailAddress, emailAddress, freeProductName),
    addToMarketingList(emailAddress),
    sendFreeProductEmail(emailAddress, freeProductName, downloadUrls, productNames),
  ]);
  
  console.log(`Free product sent to: ${emailAddress}`);
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

    // Respond to Stripe BEFORE doing slow operations
    res.json({ received: true });

    // Process asynchronously after response sent
    await Promise.all([
      addToCustomersList(email, fullName, productName),
      sendDownloadEmail(email, firstName, productName, downloadUrls),
    ]);

    console.log(`Done for ${email} — ${productName}`);
  } else {
    res.json({ received: true });
  }
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

// Add contact directly to Marketing Subscribers list (explicit consent given)
async function addToMarketingList(email) {
  const contactData = {
    email: email,
    listIds: [parseInt(process.env.MARKETING_SUBSCRIBERS_LIST_ID)],
    updateEnabled: true,
    attributes: {
      SOURCE: 'free_product',
    }
  };

  try {
    await brevoAPI.post('/contacts', contactData);
    console.log(`Added to Marketing Subscribers list: ${email}`);
  } catch (err) {
    console.error("Brevo marketing list error:", err.response?.data || err.message);
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

// Send free product download email
async function sendFreeProductEmail(email, productName, downloadUrls, productNames) {
  const emailData = {
    to: [{ email: email }],
    sender: { name: 'Matt Donald', email: process.env.BREVO_SENDER_EMAIL },
    templateId: parseInt(process.env.BREVO_FREE_PRODUCT_TEMPLATE_ID),
    params: {
      firstName: 'there',
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
    console.log(`Free product email sent to: ${email}`);
  } catch (err) {
    console.error("Brevo free product email error:", err.response?.data || err.message);
  }
}

app.listen(4242, () => console.log("Server running on port 4242"));
