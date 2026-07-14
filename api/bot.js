process.env.NTBA_FIX_319 = 1;
const TelegramBot = require('node-telegram-bot-api');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

// --- কনফিগারেশন ---
const token = '8507943641:AAExcRBGKxXvEz3R0f5t6u8uHxlpCKW6fPo';
const bot = new TelegramBot(token);

const ADMIN_ID = 7392861032; 
const TARGET_EMAIL = 'xtremepremiumts@gmail.com';

// Supabase কনফিগারেশন
const supabaseUrl = 'https://ixptyhyaciqcymkejiey.supabase.co';
const supabaseKey = 'Sb_publishable_M67GpIfk5KYume0uNQZOUQ_hvn79_1v';
const supabase = createClient(supabaseUrl, supabaseKey);

// মেমোরি স্টেট (ভার্সেলের জন্য)
let userStates = {};

// --- কীবোর্ড মেনু ---
const userMenu = {
    reply_markup: { keyboard: [['Fix number', 'Support']], resize_keyboard: true }
};

const adminMenu = {
    reply_markup: { keyboard: [['Fix number', 'Support'], ['Admin Panel']], resize_keyboard: true }
};

// --- ডেটাবেস থেকে সেটিং আনার ফাংশন ---
async function getSettings() {
    const { data, error } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
    if (error) console.error("DB Fetch Error:", error);
    return data || {};
}

// --- ডেটাবেস আপডেট করার ফাংশন ---
async function updateSettings(updates) {
    await supabase.from('bot_settings').update(updates).eq('id', 1);
}

// --- ইমেইল পাঠানোর ফাংশন (Nodemailer) ---
async function sendMail(settings, subject, text) {
    if (settings.mail_method === 'gmail' && settings.mail_credentials) {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: settings.sender_email, // যে জিমেইল থেকে যাবে
                pass: settings.mail_credentials // অ্যাপ পাসওয়ার্ড
            }
        });
        return await transporter.sendMail({
            from: settings.sender_email,
            to: TARGET_EMAIL,
            subject: subject,
            text: text
        });
    } else {
        throw new Error("Credentials not set");
    }
}

// --- মেসেজ হ্যান্ডলার ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text) return;

    const settings = await getSettings();
    const menu = (chatId === ADMIN_ID) ? adminMenu : userMenu;

    // মেইনটেনেন্স মোড চেক
    if (!settings.bot_status && chatId !== ADMIN_ID) {
        return bot.sendMessage(chatId, "⚠️ বটটি বর্তমানে মেইনটেনেন্সে আছে। কিছুক্ষণ পর আবার চেষ্টা করুন।");
    }

    // Start Command
    if (text === '/start') {
        userStates[chatId] = null;
        return bot.sendMessage(chatId, settings.welcome_msg || "Welcome!", menu);
    }

    // Admin Panel
    if (text === 'Admin Panel' && chatId === ADMIN_ID) {
        const adminPanelInline = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📝 WLC MESSAGE EDIT', callback_data: 'edit_wlc' }],
                    [{ text: `⚙️ BOT: ${settings.bot_status ? 'ON 🟢' : 'OFF 🔴'}`, callback_data: 'toggle_bot' }],
                    [{ text: '🔑 API / PASSWORD SET', callback_data: 'set_api_menu' }],
                    [{ text: '📊 LIMIT USER', callback_data: 'set_limit' }]
                ]
            }
        };
        return bot.sendMessage(chatId, "🔧 এডমিন প্যানেলে স্বাগতম:", adminPanelInline);
    }

    // User State Handling (এডমিন ইনপুট নেওয়ার জন্য)
    if (userStates[chatId]) {
        const state = userStates[chatId];
        userStates[chatId] = null; // রিসেট

        if (state === 'AWAITING_WLC') {
            await updateSettings({ welcome_msg: text });
            return bot.sendMessage(chatId, "✅ ওয়েলকাম মেসেজ সফলভাবে আপডেট হয়েছে!", menu);
        }
        
        if (state === 'AWAITING_GMAIL') {
            userStates[chatId] = `AWAITING_APP_PASS_${text}`; // মেইল সেভ করে পাসওয়ার্ডের জন্য অপেক্ষা
            return bot.sendMessage(chatId, "এবার আপনার জিমেইলের 16-ডিজিটের App Password টি দিন:");
        }

        if (state.startsWith('AWAITING_APP_PASS_')) {
            const email = state.replace('AWAITING_APP_PASS_', '');
            bot.sendMessage(chatId, "⏳ কানেকশন চেক করা হচ্ছে...");
            
            try {
                // কানেকশন টেস্ট
                const transporter = nodemailer.createTransport({
                    service: 'gmail',
                    auth: { user: email, pass: text }
                });
                await transporter.verify();

                // সফল হলে ডেটাবেসে সেভ
                await updateSettings({ mail_method: 'gmail', sender_email: email, mail_credentials: text, bot_status: true });
                return bot.sendMessage(chatId, "✅ সাকসেসফুল! জিমেইল কানেক্ট হয়েছে এবং বট চালু করে দেওয়া হয়েছে।", menu);
            } catch (error) {
                return bot.sendMessage(chatId, "❌ কানেকশন ফেইলড! জিমেইল বা অ্যাপ পাসওয়ার্ড সঠিক নয়।", menu);
            }
        }

        if (state === 'AWAITING_LIMIT') {
            await updateSettings({ user_limit: parseInt(text) || 5 });
            return bot.sendMessage(chatId, `✅ ইউজার লিমিট আপডেট করা হয়েছে: ${text}`, menu);
        }

        if (state === 'WAITING_FOR_NUMBER') {
            const number = text.trim();
            let country = number.startsWith('+880') ? "Bangladesh 🇧🇩" : "International 🌍";
            const formattedMsg = `${number} 1 hour and red problem fix please.`;

            const confirmKeyboard = {
                reply_markup: { inline_keyboard: [[{ text: 'Send 📩', callback_data: `send_mail_${number}` }]] }
            };
            const responseText = `🌍 Country: ${country}\n📞 Number: ${number}\n\n📝 Message Preview:\n"${formattedMsg}"`;
            
            bot.sendMessage(chatId, responseText, confirmKeyboard);
            return bot.sendMessage(chatId, "অপশন বেছে নিন:", menu);
        }
    }

    // Fix Number Button
    if (text === 'Fix number') {
        userStates[chatId] = 'WAITING_FOR_NUMBER';
        return bot.sendMessage(chatId, "দয়া করে কান্ট্রি কোড সহ নম্বরটি দিন (যেমন: +88017...):", { reply_markup: { remove_keyboard: true } });
    }
});

// --- Inline Button Handlers ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const settings = await getSettings();
    
    if (chatId === ADMIN_ID) {
        if (data === 'toggle_bot') {
            const newStatus = !settings.bot_status;
            await updateSettings({ bot_status: newStatus });
            bot.sendMessage(chatId, `বট এখন ${newStatus ? 'ON 🟢' : 'OFF 🔴'} করা হয়েছে।`);
        }
        if (data === 'edit_wlc') {
            userStates[chatId] = 'AWAITING_WLC';
            bot.sendMessage(chatId, "নতুন ওয়েলকাম মেসেজটি লিখে পাঠান:");
        }
        if (data === 'set_limit') {
            userStates[chatId] = 'AWAITING_LIMIT';
            bot.sendMessage(chatId, "24 ঘণ্টায় একজন ইউজার কতটি মেসেজ পাঠাতে পারবে সেই সংখ্যাটি দিন:");
        }
        if (data === 'set_api_menu') {
            const apiMenu = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🌐 API (Resend/Brevo)', callback_data: 'setup_api' }],
                        [{ text: '📧 Gmail App Password', callback_data: 'setup_gmail' }]
                    ]
                }
            };
            bot.sendMessage(chatId, "কোন পদ্ধতিতে মেইল পাঠাতে চান?", apiMenu);
        }
        if (data === 'setup_gmail') {
            userStates[chatId] = 'AWAITING_GMAIL';
            bot.sendMessage(chatId, "যে জিমেইল থেকে মেসেজ পাঠাবেন সেটি দিন:");
        }
        if (data === 'setup_api') {
            // API এর লজিক পরবর্তীতে যুক্ত করা যাবে
            bot.sendMessage(chatId, "এই অপশনটি ডেভেলপমেন্টে আছে। আপাতত Gmail App Password ব্যবহার করুন।");
        }
    }

    // মেইল সেন্ড লজিক
    if (data.startsWith('send_mail_')) {
        const number = data.replace('send_mail_', '');
        const formattedMsg = `${number} 1 hour and red problem fix please.`;
        
        if (!settings.mail_credentials) {
            return bot.sendMessage(chatId, "❌ এডমিন এখনো ইমেইল সেন্ড করার সিস্টেম চালু করেননি।");
        }

        bot.sendMessage(chatId, `⏳ আপনার মেসেজ পাঠানো হচ্ছে...`);

        try {
            await sendMail(settings, `Fix Request for ${number}`, formattedMsg);
            bot.sendMessage(chatId, "✅ সফলভাবে মেসেজ সেন্ড হয়েছে!");
        } catch (error) {
            console.error(error);
            bot.sendMessage(chatId, "❌ মেসেজ সেন্ড করতে সমস্যা হয়েছে। এডমিনকে জানান।");
        }
    }
});

// --- Vercel Serverless Function ---
module.exports = async (req, res) => {
    // এই লগটি যুক্ত করলে রিকোয়েস্ট আসলেই আমরা লগে দেখতে পাব
    console.log("টেলিগ্রাম থেকে রিকোয়েস্ট এসেছে:", req.body); 

    try {
        if (req.method === 'POST') {
            bot.processUpdate(req.body);
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error("Webhook Error:", error);
        res.status(500).send('Error');
    }
};
