process.env.NTBA_FIX_319 = 1;
const TelegramBot = require('node-telegram-bot-api');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

// --- কনফিগারেশন ---
const token = '8507943641:AAExcRBGKxXvEz3R0f5t6u8uHxlpCKW6fPo';
const bot = new TelegramBot(token);

const ADMIN_ID = 7392861032; 
const TARGET_EMAIL = 'xtremepremiumts@gmail.com';

// Supabase কনফিগারেশন (আপনার Key টি ভুল ছিল, তাই সেভ হচ্ছিল না। সঠিক Key বসাবেন)
const supabaseUrl = 'https://ixptyhyaciqcymkejiey.supabase.co';
const supabaseKey = 'Sb_publishable_M67GpIfk5KYume0uNQZOUQ_hvn79_1v'; // দয়া করে Supabase থেকে সঠিক eyJ... Key টি এনে এখানে বসান
const supabase = createClient(supabaseUrl, supabaseKey);

let cachedSettings = null; 
let userStates = {};

// --- রেগুলার কীবোর্ড মেনু (সব ইনলাইন বাটন বাদ) ---
const userMenu = { 
    reply_markup: { keyboard: [['📱 Fix number', '🎧 Support']], resize_keyboard: true } 
};

const adminMenu = { 
    reply_markup: { keyboard: [['📱 Fix number', '🎧 Support'], ['⚙️ Admin Panel']], resize_keyboard: true } 
};

const adminPanelMenu = {
    reply_markup: { 
        keyboard: [
            ['📝 WLC MESSAGE EDIT', '⚙️ BOT ON/OFF'],
            ['🔑 SET EMAIL API', '📊 LIMIT USER'],
            ['🔙 Main Menu']
        ], 
        resize_keyboard: true 
    }
};

const confirmSendMenu = {
    reply_markup: { 
        keyboard: [['📩 Send Message', '❌ Cancel']], 
        resize_keyboard: true 
    }
};

// --- উন্নত কান্ট্রি ডিটেকশন (যেকোনো ফরম্যাটে কাজ করবে) ---
function detectCountry(num) {
    const cleanNum = num.replace(/\D/g, ''); // সব + বা স্পেস সরিয়ে শুধু সংখ্যা নেবে
    if (cleanNum.startsWith('880')) return "Bangladesh 🇧🇩";
    if (cleanNum.startsWith('261')) return "Madagascar 🇲🇬"; // আপনার স্ক্রিনশটের কোড
    if (cleanNum.startsWith('91')) return "India 🇮🇳";
    if (cleanNum.startsWith('92')) return "Pakistan 🇵🇰";
    if (cleanNum.startsWith('1')) return "USA/Canada 🇺🇸🇨🇦";
    if (cleanNum.startsWith('44')) return "UK 🇬🇧";
    if (cleanNum.startsWith('971')) return "UAE 🇦🇪";
    if (cleanNum.startsWith('60')) return "Malaysia 🇲🇾";
    return "International 🌍";
}

// --- ডাটাবেস ফেচ ---
async function getSettings() {
    if (cachedSettings) return cachedSettings; 
    
    try {
        const { data, error } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
        if (error) throw error;
        cachedSettings = data; 
        return cachedSettings;
    } catch (error) {
        // ডেটাবেস কাজ না করলে ডিফল্ট সেটিং মেমোরিতে রাখবে যেন বট থেমে না যায়
        return { bot_status: true, user_limit: 5, welcome_msg: "<b>বটে আপনাকে স্বাগতম!</b>", mail_method: '', mail_credentials: '', sender_email: '' };
    }
}

// --- ডাটাবেস আপডেট ---
async function updateSettings(updates, chatId) {
    const current = await getSettings();
    const merged = { ...current, ...updates, id: 1 };
    
    const { error } = await supabase.from('bot_settings').upsert(merged);
    if (!error) {
        cachedSettings = merged; 
        return true;
    } else {
        // ডাটাবেসে এরর হলে এডমিনকে মেসেজ দিয়ে জানাবে
        bot.sendMessage(chatId, `⚠️ <b>Database Error:</b>\n<code>${error.message}</code>\n<i>আপনার Supabase API Key অথবা টেবিল ঠিক নেই!</i>`, { parse_mode: 'HTML' });
        return false;
    }
}

// --- মেসেজ হ্যান্ডলার ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    if (!text) return;

    const settings = await getSettings();
    const menu = (chatId === ADMIN_ID) ? adminMenu : userMenu;

    // মেইনটেনেন্স মোড
    if (settings.bot_status === false && chatId !== ADMIN_ID) {
        return bot.sendMessage(chatId, "⚠️ <b>বটটি বর্তমানে মেইনটেনেন্সে আছে।</b>\n<i>কিছুক্ষণ পর আবার চেষ্টা করুন।</i>", { parse_mode: 'HTML' });
    }

    // --- State Handling (সব কমান্ডের আগে) ---
    if (userStates[chatId]) {
        const state = userStates[chatId];

        if (state === 'AWAITING_WLC') {
            userStates[chatId] = null;
            const success = await updateSettings({ welcome_msg: text }, chatId);
            if (success) bot.sendMessage(chatId, "✅ <b>ওয়েলকাম মেসেজ সফলভাবে আপডেট হয়েছে!</b>", { parse_mode: 'HTML', ...adminPanelMenu });
            return;
        }
        
        if (state === 'AWAITING_GMAIL') {
            userStates[chatId] = `AWAITING_APP_PASS_${text}`; 
            return bot.sendMessage(chatId, "🔑 <b>এবার আপনার জিমেইলের 16-ডিজিটের App Password টি দিন:</b>", { parse_mode: 'HTML' });
        }

        if (state.startsWith('AWAITING_APP_PASS_')) {
            const email = state.replace('AWAITING_APP_PASS_', '');
            userStates[chatId] = null;
            bot.sendMessage(chatId, "⏳ <i>কানেকশন চেক করা হচ্ছে...</i>", { parse_mode: 'HTML' });
            
            try {
                const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: email, pass: text } });
                await transporter.verify(); 

                const success = await updateSettings({ mail_method: 'gmail', sender_email: email, mail_credentials: text, bot_status: true }, chatId);
                if (success) bot.sendMessage(chatId, "✅ <b>সাকসেসফুল! জিমেইল কানেক্ট হয়েছে এবং সেভ হয়েছে।</b>", { parse_mode: 'HTML', ...adminPanelMenu });
            } catch (error) {
                bot.sendMessage(chatId, "❌ <b>কানেকশন ফেইলড! জিমেইল বা অ্যাপ পাসওয়ার্ড সঠিক নয়।</b>", { parse_mode: 'HTML', ...adminPanelMenu });
            }
            return;
        }

        if (state === 'AWAITING_LIMIT') {
            userStates[chatId] = null;
            const limitValue = parseInt(text) || 5;
            const success = await updateSettings({ user_limit: limitValue }, chatId);
            if (success) bot.sendMessage(chatId, `✅ <b>ইউজার লিমিট আপডেট করা হয়েছে:</b> <code>${limitValue}</code>`, { parse_mode: 'HTML', ...adminPanelMenu });
            return;
        }

        if (state === 'WAITING_FOR_NUMBER') {
            const number = text.trim();
            userStates[chatId] = `CONFIRM_SEND_${number}`; // নাম্বার সেভ করে সেন্ডের জন্য অপেক্ষা
            
            const country = detectCountry(number);
            const formattedMsg = `+${number.replace(/\D/g, '')} 1 hour and red problem fix please.`;

            const responseText = `🌍 <b>Country:</b> ${country}\n📞 <b>Number:</b> <code>${number}</code>\n\n📝 <b>Message Preview:</b>\n"<i>${formattedMsg}</i>"\n\nনিচের বাটন থেকে Send Message এ ক্লিক করুন।`;
            
            return bot.sendMessage(chatId, responseText, { parse_mode: 'HTML', ...confirmSendMenu });
        }
    }

    // --- Main Commands ---
    if (text === '/start') {
        userStates[chatId] = null;
        return bot.sendMessage(chatId, settings.welcome_msg, { parse_mode: 'HTML', ...menu });
    }

    if (text === '🔙 Main Menu') {
        userStates[chatId] = null;
        return bot.sendMessage(chatId, "🏠 <b>মেইন মেনু:</b>", { parse_mode: 'HTML', ...menu });
    }

    if (text === '⚙️ Admin Panel' && chatId === ADMIN_ID) {
        userStates[chatId] = null;
        return bot.sendMessage(chatId, "<b>🔧 এডমিন প্যানেলে স্বাগতম:</b>", { parse_mode: 'HTML', ...adminPanelMenu });
    }

    if (text === '📱 Fix number') {
        userStates[chatId] = 'WAITING_FOR_NUMBER';
        return bot.sendMessage(chatId, "📞 <b>দয়া করে কান্ট্রি কোড সহ নম্বরটি দিন</b>\n<i>(যেমন: 88017... বা 26156...):</i>", { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    }
    
    if (text === '🎧 Support') {
        return bot.sendMessage(chatId, "👨‍💻 <b>সাহায্যের জন্য এডমিনের সাথে যোগাযোগ করুন।</b>", { parse_mode: 'HTML' });
    }

    // --- Admin Panel Buttons ---
    if (chatId === ADMIN_ID) {
        if (text === '⚙️ BOT ON/OFF') {
            const newStatus = !settings.bot_status;
            await updateSettings({ bot_status: newStatus }, chatId);
            return bot.sendMessage(chatId, `✅ বট এখন <b>${newStatus ? 'ON 🟢' : 'OFF 🔴'}</b> করা হয়েছে।`, { parse_mode: 'HTML' });
        }
        if (text === '📝 WLC MESSAGE EDIT') {
            userStates[chatId] = 'AWAITING_WLC';
            return bot.sendMessage(chatId, "📝 <b>নতুন ওয়েলকাম মেসেজটি লিখে পাঠান:</b>", { parse_mode: 'HTML' });
        }
        if (text === '📊 LIMIT USER') {
            userStates[chatId] = 'AWAITING_LIMIT';
            return bot.sendMessage(chatId, "📊 <b>ইউজার লিমিটের সংখ্যা দিন:</b>", { parse_mode: 'HTML' });
        }
        if (text === '🔑 SET EMAIL API') {
            userStates[chatId] = 'AWAITING_GMAIL';
            return bot.sendMessage(chatId, "📧 <b>যে জিমেইল থেকে মেসেজ পাঠাবেন সেটি দিন:</b>\n<i>(API মেইনটেনেন্সে থাকায় সরাসরি জিমেইল দিন)</i>", { parse_mode: 'HTML' });
        }
    }

    // --- Send Logic (কীবোর্ড থেকে) ---
    if (text === '❌ Cancel') {
        userStates[chatId] = null;
        return bot.sendMessage(chatId, "🚫 <b>রিকোয়েস্ট বাতিল করা হয়েছে।</b>", { parse_mode: 'HTML', ...menu });
    }

    if (text === '📩 Send Message') {
        if (!userStates[chatId] || !userStates[chatId].startsWith('CONFIRM_SEND_')) {
            return bot.sendMessage(chatId, "⚠️ <b>আগে একটি নাম্বার দিন।</b>", { parse_mode: 'HTML', ...menu });
        }

        const number = userStates[chatId].replace('CONFIRM_SEND_', '');
        userStates[chatId] = null; // প্রসেস শেষ
        const formattedMsg = `+${number.replace(/\D/g, '')} 1 hour and red problem fix please.`;
        
        if (!settings.mail_credentials) {
            return bot.sendMessage(chatId, "❌ <b>এডমিন এখনো ইমেইল সেন্ড করার সিস্টেম চালু করেননি।</b>", { parse_mode: 'HTML', ...menu });
        }

        bot.sendMessage(chatId, `⏳ <i>আপনার মেসেজ পাঠানো হচ্ছে...</i>`, { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });

        try {
            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: { user: settings.sender_email, pass: settings.mail_credentials }
            });
            await transporter.sendMail({
                from: settings.sender_email,
                to: TARGET_EMAIL,
                subject: `Fix Request for +${number.replace(/\D/g, '')}`,
                text: formattedMsg
            });
            bot.sendMessage(chatId, "✅ <b>সফলভাবে মেসেজ সেন্ড হয়েছে!</b>", { parse_mode: 'HTML', ...menu });
        } catch (error) {
            bot.sendMessage(chatId, `❌ <b>মেসেজ সেন্ড করতে সমস্যা হয়েছে।</b>\n<i>Error: ${error.message}</i>`, { parse_mode: 'HTML', ...menu });
        }
    }
});

module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            bot.processUpdate(req.body);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
        res.status(200).send('OK');
    } catch (error) {
        res.status(500).send('Error');
    }
};
