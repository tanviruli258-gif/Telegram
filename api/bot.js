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

let cachedSettings = null; 
let userStates = {};

// --- কীবোর্ড মেনু (Premium Look) ---
const userMenu = { reply_markup: { keyboard: [['📱 Fix number', '🎧 Support']], resize_keyboard: true } };
const adminMenu = { reply_markup: { keyboard: [['📱 Fix number', '🎧 Support'], ['⚙️ Admin Panel']], resize_keyboard: true } };

function getAdminPanelInline(settings) {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📝 WLC MESSAGE EDIT', callback_data: 'edit_wlc' }],
                [{ text: `⚙️ BOT: ${settings.bot_status ? 'ON 🟢' : 'OFF 🔴'}`, callback_data: 'toggle_bot' }],
                [{ text: '🔑 API / PASSWORD SET', callback_data: 'set_api_menu' }],
                [{ text: `📊 LIMIT USER (${settings.user_limit || 5})`, callback_data: 'set_limit' }]
            ]
        }
    };
}

// --- কান্ট্রি ডিটেকশন ---
function detectCountry(number) {
    if (number.startsWith('+880')) return "Bangladesh 🇧🇩";
    if (number.startsWith('+91')) return "India 🇮🇳";
    if (number.startsWith('+92')) return "Pakistan 🇵🇰";
    if (number.startsWith('+1')) return "USA/Canada 🇺🇸🇨🇦";
    if (number.startsWith('+44')) return "UK 🇬🇧";
    if (number.startsWith('+971')) return "UAE 🇦🇪";
    if (number.startsWith('+966')) return "Saudi Arabia 🇸🇦";
    if (number.startsWith('+60')) return "Malaysia 🇲🇾";
    return "International 🌍";
}

// --- ডাটাবেস ফেচ ---
async function getSettings() {
    if (cachedSettings) return cachedSettings; 
    const { data, error } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
    if (!data || error) {
        const defaultSettings = { id: 1, welcome_msg: "<b>বটে আপনাকে স্বাগতম!</b>", bot_status: true, user_limit: 5, mail_method: '', mail_credentials: '', sender_email: '' };
        await supabase.from('bot_settings').upsert(defaultSettings);
        cachedSettings = defaultSettings;
        return cachedSettings;
    }
    cachedSettings = data; 
    return cachedSettings;
}

// --- ডাটাবেস আপডেট (100% Guaranteed Save - Upsert) ---
async function updateSettings(updates) {
    const current = await getSettings();
    const merged = { ...current, ...updates, id: 1 };
    
    // upsert ব্যবহার করায় এটি বাধ্য হয়ে ডাটাবেসে সেভ করবেই
    const { error } = await supabase.from('bot_settings').upsert(merged);
    if (!error) {
        cachedSettings = merged; 
    } else {
        console.error("DB Update Error:", error);
    }
}

// --- ইমেইল সেন্ডার ---
async function sendMail(settings, subject, text) {
    if (settings.mail_method === 'gmail' && settings.mail_credentials) {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: settings.sender_email, pass: settings.mail_credentials }
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

    if (settings.bot_status === false && chatId !== ADMIN_ID) {
        return bot.sendMessage(chatId, "⚠️ <b>বটটি বর্তমানে মেইনটেনেন্সে আছে।</b>\n<i>কিছুক্ষণ পর আবার চেষ্টা করুন।</i>", { parse_mode: 'HTML' });
    }

    if (text === '/start') {
        userStates[chatId] = null;
        return bot.sendMessage(chatId, settings.welcome_msg, { parse_mode: 'HTML', ...menu });
    }

    if (text === '⚙️ Admin Panel' && chatId === ADMIN_ID) {
        return bot.sendMessage(chatId, "<b>🔧 এডমিন প্যানেলে স্বাগতম:</b>", { parse_mode: 'HTML', ...getAdminPanelInline(settings) });
    }

    if (userStates[chatId]) {
        const state = userStates[chatId];
        userStates[chatId] = null; 

        if (state === 'AWAITING_WLC') {
            await updateSettings({ welcome_msg: text });
            return bot.sendMessage(chatId, "✅ <b>ওয়েলকাম মেসেজ সফলভাবে আপডেট হয়েছে!</b>", { parse_mode: 'HTML', ...menu });
        }
        
        if (state === 'AWAITING_GMAIL') {
            userStates[chatId] = `AWAITING_APP_PASS_${text}`; 
            return bot.sendMessage(chatId, "🔑 <b>এবার আপনার জিমেইলের 16-ডিজিটের App Password টি দিন:</b>", { parse_mode: 'HTML' });
        }

        if (state.startsWith('AWAITING_APP_PASS_')) {
            const email = state.replace('AWAITING_APP_PASS_', '');
            bot.sendMessage(chatId, "⏳ <i>কানেকশন চেক করা হচ্ছে...</i>", { parse_mode: 'HTML' });
            
            try {
                const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: email, pass: text } });
                await transporter.verify(); 

                // সফল হলে ডেটাবেসে পার্মানেন্টলি সেভ হবে
                await updateSettings({ mail_method: 'gmail', sender_email: email, mail_credentials: text, bot_status: true });
                return bot.sendMessage(chatId, "✅ <b>সাকসেসফুল!</b> জিমেইল কানেক্ট হয়েছে এবং বট চালু করে দেওয়া হয়েছে।", { parse_mode: 'HTML', ...menu });
            } catch (error) {
                return bot.sendMessage(chatId, "❌ <b>কানেকশন ফেইলড!</b> জিমেইল বা অ্যাপ পাসওয়ার্ড সঠিক নয়।", { parse_mode: 'HTML', ...menu });
            }
        }

        if (state === 'AWAITING_LIMIT') {
            const limitValue = parseInt(text) || 5;
            await updateSettings({ user_limit: limitValue });
            return bot.sendMessage(chatId, `✅ <b>ইউজার লিমিট আপডেট করা হয়েছে:</b> <code>${limitValue}</code>`, { parse_mode: 'HTML', ...menu });
        }

        if (state === 'WAITING_FOR_NUMBER') {
            const number = text.trim();
            const country = detectCountry(number);
            const formattedMsg = `${number} 1 hour and red problem fix please.`;

            const confirmKeyboard = {
                reply_markup: { inline_keyboard: [[{ text: '🚀 Send Request', callback_data: `send_mail_${number}` }]] }
            };
            const responseText = `🌍 <b>Country:</b> ${country}\n📞 <b>Number:</b> <code>${number}</code>\n\n📝 <b>Message Preview:</b>\n"<i>${formattedMsg}</i>"`;
            
            return bot.sendMessage(chatId, responseText, { parse_mode: 'HTML', ...confirmKeyboard });
        }
    }

    if (text === '📱 Fix number') {
        userStates[chatId] = 'WAITING_FOR_NUMBER';
        return bot.sendMessage(chatId, "📞 <b>দয়া করে কান্ট্রি কোড সহ নম্বরটি দিন</b>\n<i>(যেমন: +88017...):</i>", { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    }
    
    if (text === '🎧 Support') {
        return bot.sendMessage(chatId, "👨‍💻 <b>সাহায্যের জন্য এডমিনের সাথে যোগাযোগ করুন।</b>", { parse_mode: 'HTML' });
    }
});

// --- Inline Button Handlers ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;
    const settings = await getSettings();
    
    if (chatId === ADMIN_ID) {
        if (data === 'toggle_bot') {
            const newStatus = !settings.bot_status;
            await updateSettings({ bot_status: newStatus });
            
            bot.editMessageReplyMarkup(getAdminPanelInline(cachedSettings).reply_markup, {
                chat_id: chatId, message_id: messageId
            });
        }
        if (data === 'edit_wlc') {
            userStates[chatId] = 'AWAITING_WLC';
            bot.sendMessage(chatId, "📝 <b>নতুন ওয়েলকাম মেসেজটি লিখে পাঠান:</b>\n<i>(আপনি চাইলে লেখায় HTML ট্যাগ ব্যবহার করতে পারেন)</i>", { parse_mode: 'HTML' });
        }
        if (data === 'set_limit') {
            userStates[chatId] = 'AWAITING_LIMIT';
            bot.sendMessage(chatId, "📊 <b>24 ঘণ্টায় একজন ইউজার কতটি মেসেজ পাঠাতে পারবে সেই সংখ্যাটি দিন:</b>", { parse_mode: 'HTML' });
        }
        
        if (data === 'set_api_menu') {
            const apiMenu = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🌐 API (Maintenance)', callback_data: 'setup_api' }],
                        [{ text: '📧 Gmail App Password', callback_data: 'setup_gmail' }]
                    ]
                }
            };
            bot.sendMessage(chatId, "⚙️ <b>মেইল পাঠানোর মাধ্যম নির্বাচন করুন:</b>", { parse_mode: 'HTML', ...apiMenu });
        }
        if (data === 'setup_gmail') {
            userStates[chatId] = 'AWAITING_GMAIL';
            bot.sendMessage(chatId, "📧 <b>যে জিমেইল থেকে মেসেজ পাঠাবেন সেটি দিন:</b>", { parse_mode: 'HTML' });
        }
        
        if (data === 'setup_api') {
            const maintMsg = "⚠️ <b>𝗦𝘆𝘀𝘁𝗲𝗺 𝗨𝗻𝗱𝗲𝗿 𝗠𝗮𝗶𝗻𝘁𝗲𝗻𝗮𝗻𝗰𝗲</b> ⚠️\n\n<i>This system is currently undergoing upgrades. Please utilize the Gmail App Password method for now.</i> 🚀✨";
            bot.sendMessage(chatId, maintMsg, { parse_mode: 'HTML' });
        }
    }

    if (data.startsWith('send_mail_')) {
        const number = data.replace('send_mail_', '');
        const formattedMsg = `${number} 1 hour and red problem fix please.`;
        
        if (!settings.mail_credentials) {
            return bot.sendMessage(chatId, "❌ <b>এডমিন এখনো ইমেইল সেন্ড করার সিস্টেম চালু করেননি।</b>", { parse_mode: 'HTML' });
        }

        bot.sendMessage(chatId, `⏳ <i>আপনার মেসেজ পাঠানো হচ্ছে...</i>`, { parse_mode: 'HTML' });

        try {
            await sendMail(settings, `Fix Request for ${number}`, formattedMsg);
            bot.sendMessage(chatId, "✅ <b>সফলভাবে মেসেজ সেন্ড হয়েছে!</b>", { parse_mode: 'HTML' });
        } catch (error) {
            console.error(error);
            bot.sendMessage(chatId, "❌ <b>মেসেজ সেন্ড করতে সমস্যা হয়েছে। এডমিনকে জানান।</b>", { parse_mode: 'HTML' });
        }
    }
});

// --- Vercel Webhook Handler ---
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.processUpdate(req.body);
            // Vercel Timeout Fix: বটকে প্রসেস শেষ করার সময় দেওয়া হচ্ছে
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error("Webhook Error:", error);
        res.status(500).send('Error');
    }
};
