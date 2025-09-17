'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const mongoose = require('mongoose');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
require('dotenv').config();
// Fallback: load yep.env if .env not present
if (!process.env.FIREBASE_API_KEY) {
	const altEnvPath = path.join(__dirname, 'yep.env');
	if (fs.existsSync(altEnvPath)) {
		require('dotenv').config({ path: altEnvPath });
	}
}

const app = express();
const seedFs = require('fs');
const seedPath = path.join(__dirname, 'data', 'archives.seed.json');
let seedArchives = [];
try {
    if (seedFs.existsSync(seedPath)) {
        seedArchives = JSON.parse(seedFs.readFileSync(seedPath, 'utf8')) || [];
    }
} catch (e) { console.warn('Failed to load seed archives', e); }

// Security middlewares
app.use(helmet({
	contentSecurityPolicy: false
}));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
// --- Database (MongoDB via Mongoose) ---
const mongoUri = process.env.MONGO_URI || '';
if (mongoUri) {
    mongoose.connect(mongoUri).then(() => console.log('MongoDB connected')).catch((e) => console.error('MongoDB connection error', e));
}

const bookingSchema = new mongoose.Schema({
    festivalName: String,
    name: String,
    email: String,
    participants: Number,
    date: String,
    paymentStatus: { type: String, default: 'pending' },
    paymentId: String,
    createdAt: { type: Date, default: Date.now }
});
const Booking = mongoose.models.Booking || mongoose.model('Booking', bookingSchema);

// --- Archives (Digital Archives) ---
const archiveSchema = new mongoose.Schema({
    monasteryId: Number,
    monasteryName: String,
    type: String, // Manuscript / Mural / Photograph / Document
    title: String,
    description: String,
    period: String,
    material: String,
    dimensions: String,
    significance: String,
    description_i18n: {
        en: String,
        hi: String,
        ne: String
    },
    date: String,
    language: String,
    fileUrl: String,
    tags: [String],
    keywords: [String],
    createdAt: { type: Date, default: Date.now }
});
const Archive = mongoose.models.Archive || mongoose.model('Archive', archiveSchema);

function autoCategorizeTags(doc) {
    const tags = new Set(Array.isArray(doc.tags) ? doc.tags : []);
    const t = (doc.type || '').toLowerCase();
    if (t.includes('mural')) tags.add('mural');
    if (t.includes('manuscript')) tags.add('manuscript');
    if (t.includes('photograph') || t.includes('photo') || t.includes('image')) tags.add('photograph');
    if (t.includes('document')) tags.add('document');
    const lang = (doc.language || '').toLowerCase();
    if (lang) tags.add(`lang:${lang}`);
    if (doc.monasteryName) tags.add(`monastery:${doc.monasteryName}`);
    return Array.from(tags);
}

async function seedMongoIfNeeded() {
    try {
        if (!mongoUri || !seedArchives.length) return;
        const count = await Archive.countDocuments();
        if (count === 0) {
            const docs = seedArchives.map(s => ({ ...s, tags: autoCategorizeTags(s) }));
            await Archive.insertMany(docs);
            console.log(`Seeded ${docs.length} archive documents.`);
        }
    } catch (e) { console.warn('Seeding failed', e); }
}

if (mongoUri) {
    mongoose.connection.once('open', seedMongoIfNeeded);
}

// List/filter archives
app.get('/api/archives', async (req, res) => {
    try {
        const { q, type, language, year, monasteryId, monasteryName, limit = 50 } = req.query;
        if (!mongoUri) {
            // In-memory filter over seed data
            let list = seedArchives.slice();
            if (type) list = list.filter(x => (x.type || '') === type);
            if (language) list = list.filter(x => (x.language || '') === language);
            if (year) list = list.filter(x => (x.date || '') === year);
            if (monasteryId) list = list.filter(x => String(x.monasteryId || '') === String(monasteryId));
            if (monasteryName) list = list.filter(x => (x.monasteryName || '') === monasteryName);
            if (q) {
                const r = new RegExp(q, 'i');
                list = list.filter(x => r.test(x.title || '') || r.test(x.description || '') || r.test(x.monasteryName || '') || (x.tags || []).some(t => r.test(t)) || (x.keywords || []).some(t => r.test(t)));
            }
            return res.json({ ok: true, archives: list.slice(0, Math.min(200, Number(limit))) });
        }
        const filter = {};
        if (type) filter.type = type;
        if (language) filter.language = language;
        if (year) filter.date = year;
        if (monasteryId) filter.monasteryId = Number(monasteryId);
        if (monasteryName) filter.monasteryName = monasteryName;
        if (q) {
            filter.$or = [
                { title: { $regex: q, $options: 'i' } },
                { description: { $regex: q, $options: 'i' } },
                { monasteryName: { $regex: q, $options: 'i' } },
                { tags: { $regex: q, $options: 'i' } },
                { keywords: { $regex: q, $options: 'i' } }
            ];
        }
        const list = await Archive.find(filter).sort({ createdAt: -1 }).limit(Math.min(200, Number(limit))).lean();
        res.json({ ok: true, archives: list });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to fetch archives' });
    }
});

// Fetch one archive
app.get('/api/archives/:id', async (req, res) => {
    try {
        if (!mongoUri) {
            const item = seedArchives.find(a => String(a._id || '') === String(req.params.id));
            if (!item) return res.status(404).json({ error: 'Not found' });
            return res.json({ ok: true, archive: item });
        }
        const item = await Archive.findById(req.params.id).lean();
        if (!item) return res.status(404).json({ error: 'Not found' });
        res.json({ ok: true, archive: item });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to fetch archive' });
    }
});

// Add new archive (simple token check for admin)
app.post('/api/archives', async (req, res) => {
    try {
        if (!mongoUri) return res.status(500).json({ error: 'Database not configured' });
        const adminToken = req.headers['x-admin-token'] || '';
        if (!process.env.ADMIN_TOKEN || adminToken !== process.env.ADMIN_TOKEN) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const body = req.body || {};
        body.tags = autoCategorizeTags(body);
        const created = await Archive.create(body);
        res.json({ ok: true, archive: created });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to create archive' });
    }
});

// --- Payment (Stripe) ---
const stripeSecret = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

// Expose whether Stripe public key is present to client (for feature gating)
app.get('/__public_keys', (req, res) => {
    res.json({ stripePublicKey: process.env.STRIPE_PUBLIC_KEY || '' });
});

// Create checkout session
app.post('/api/bookings/create-session', async (req, res) => {
    try {
        if (!stripe) return res.status(400).json({ error: 'Payments not configured' });
        const { festivalName, name, email, participants, date } = req.body || {};
        if (!festivalName || !name || !email || !participants || !date) {
            return res.status(400).json({ error: 'Missing fields' });
        }
        const amountPerPersonInINR = parseInt(process.env.PRICE_PER_PERSON || '499', 10) * 100; // in paisa
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            customer_email: email,
            line_items: [{
                price_data: {
                    currency: 'inr',
                    product_data: { name: `${festivalName} - Entry` },
                    unit_amount: amountPerPersonInINR
                },
                quantity: parseInt(participants, 10)
            }],
            success_url: `${req.protocol}://${req.get('host')}/?booking=success`,
            cancel_url: `${req.protocol}://${req.get('host')}/?booking=cancel`,
            metadata: { festivalName, name, email, participants: String(participants), date }
        });
        res.json({ id: session.id, url: session.url });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to create session' });
    }
});

// Webhook for payment success (optional; requires endpoint secret)
// Alternatively, client-side polling with session retrieve can be used.

// Create booking record (pre or post payment)
app.post('/api/bookings', async (req, res) => {
    try {
        if (!mongoUri) return res.status(500).json({ error: 'Database not configured' });
        const { festivalName, name, email, participants, date, paymentStatus = 'pending', paymentId = '' } = req.body || {};
        const booking = await Booking.create({ festivalName, name, email, participants, date, paymentStatus, paymentId });
        res.json({ ok: true, booking });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to save booking' });
    }
});

app.get('/api/bookings', async (req, res) => {
    try {
        if (!mongoUri) return res.status(500).json({ error: 'Database not configured' });
        const list = await Booking.find().sort({ createdAt: -1 }).lean();
        res.json({ ok: true, bookings: list });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to fetch bookings' });
    }
});

// Email confirmation with QR code
app.post('/api/bookings/:id/confirm', async (req, res) => {
    try {
        if (!mongoUri) return res.status(500).json({ error: 'Database not configured' });
        const booking = await Booking.findById(req.params.id);
        if (!booking) return res.status(404).json({ error: 'Not found' });

        const qrPayload = JSON.stringify({ id: booking.id, name: booking.name, festival: booking.festivalName, date: booking.date });
        const qrDataUrl = await QRCode.toDataURL(qrPayload);

        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587', 10),
            secure: false,
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        });

        const info = await transporter.sendMail({
            from: process.env.MAIL_FROM || 'no-reply@monastery360.local',
            to: booking.email,
            subject: `Booking Confirmed: ${booking.festivalName}`,
            html: `<p>Dear ${booking.name},</p><p>Your booking for <strong>${booking.festivalName}</strong> on <strong>${booking.date}</strong> is confirmed.</p><p>Participants: ${booking.participants}</p><p>Please present this QR code at check-in:</p><img src="${qrDataUrl}" alt="QR Code" />`,
        });
        res.json({ ok: true, messageId: info.messageId });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Failed to send email' });
    }
});

// Serve static assets
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, { maxAge: '1d', index: false }));
// (reverted) No special archive assets directory bootstrap

// Firebase config injection
function getFirebaseConfigString() {
	const cfg = {
		apiKey: process.env.FIREBASE_API_KEY || '',
		authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
		projectId: process.env.FIREBASE_PROJECT_ID || '',
		storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
		messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
		appId: process.env.FIREBASE_APP_ID || ''
	};
	return JSON.stringify(cfg);
}

// Serve index with runtime Firebase config injection
app.get(['/', '/index.html'], (req, res, next) => {
	res.setHeader('Cache-Control', 'no-store');
	const filePath = path.join(publicDir, 'index.html');
	fs.readFile(filePath, 'utf8', (err, data) => {
		if (err) return next(err);
		const injected = data.replace('__FIREBASE_CONFIG__', getFirebaseConfigString());
		res.type('html').send(injected);
	});
});

// Fallback to index for other routes (SPA style)
app.get('*', (req, res, next) => {
	if (req.path.endsWith('.html')) return next();
	res.redirect('/');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
	console.log(`Monastery360 running on http://localhost:${port}`);
});


