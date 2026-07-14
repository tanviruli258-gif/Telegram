process.env.NTBA_FIX_319 = 1;
const TelegramBot = require('node-telegram-bot-api');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const token = '8507943641:AAExcRBGKxXvEz3R0f5t6u8uHxlpCKW6fPo';
const bot = new TelegramBot(token);
const ADMIN_ID = 7392861032; 

const supabase = createClient('https://ixptyhyaciqcymkejiey.supabase.co', 'YOUR_SECRET_KEY_HERE'); // আপনার Secret Key বসান

let userStates = {};

// --- Helper Functions ---
async function getSettings() {
    const { data } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
    return data || { bot_status: true, welcome_msg: "স্বাগতম!", approval_mode: false, user_limit: 2 };
}

async function checkSpam(chatId) {
    const { data } = await supabase.from('bot_users').select('*').eq('telegram_id', chatId).single();
    if (!data) return false;
    if (data.cooldown_until && new Date(data.cooldown_until) > new Date()) return true;
    return false;
}

// --- Main Handler ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const settings = await getSettings();

    // 1. স্প্যাম প্রোটেকশন চেক
    if (await checkSpam(chatId)) {
        return bot.sendMessage(chatId, "🚫 আপনি সাময়িকভাবে ব্লকড। ২০ মিনিট পর আবার চেষ্টা করুন।");
    }

    // 2. অ্যাপ্রুভাল চেক
    const { data: user } = await supabase.from('bot_users').select('*').eq('telegram_id', chatId).single();
    if (settings.approval_mode && (!user || !user.is_approved) && chatId !== ADMIN_ID) {
        return bot.sendMessage(chatId, "⏳ আপনার রিকোয়েস্টটি পেন্ডিং আছে, দয়া করে অ্যাডমিনের অ্যাপ্রুভালের জন্য অপেক্ষা করুন।");
    }

    // 3. মেনু ও অ্যাডমিন কন্ট্রোল
    if (text === '/start') {
        return bot.sendMessage(chatId, settings.welcome_msg, { parse_mode: 'HTML' });
    }

    if (text === '📱 Fix number') {
        userStates[chatId] = 'WAITING_FOR_NUMBER';
        return bot.sendMessage(chatId, "📞 নম্বরটি দিন:");
    }

    if (userStates[chatId] === 'WAITING_FOR_NUMBER') {
        const number = text.trim();
        userStates[chatId] = null;
        
        const previewMsg = `🌍 <b>Number:</b> <code>${number}</code>\n📝 <i>Wait one minute for reply and better result.</i>`;
        const opts = {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: '📩 Send Message', callback_data: `send_${number}` }]]
            }
        };
        bot.sendMessage(chatId, previewMsg, opts);
    }
});

// --- Callback Handler ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('send_')) {
        const number = data.split('_')[1];
        bot.editMessageText(`⏳ <b>মেসেজ পাঠানো হচ্ছে...</b>`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' });
        
        // এখানে আপনার মেইল পাঠানোর লজিক বসবে
        await new Promise(r => setTimeout(r, 1000));
        
        bot.editMessageText(`✅ <b>সাকসেসফুল!</b>\nNumber: <code>${number}</code>\n<i>Wait one minute for reply and better result.</i>`, { 
            chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' 
        });
    }
});

module.exports = async (req, res) => {
    bot.processUpdate(req.body);
    res.status(200).send('OK');
};
