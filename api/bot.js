process.env.NTBA_FIX_319 = 1;
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

// ================= CONFIGURATION =================
const BOT_TOKEN = '8507943641:AAExcRBGKxXvEz3R0f5t6u8uHxlpCKW6fPo';
const ADMIN_IDS = [7392861032]; 
const SUPABASE_URL = 'https://ixptyhyaciqcymkejiey.supabase.co';
const SUPABASE_SECRET_KEY = 'sb_publishable_M67GpIfk5KYume0uNQZOUQ_hvn79_1v'; 
// =================================================

const bot = new TelegramBot(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// --- Keyboards ---
const mainMenu = { reply_markup: { keyboard: [['📱 Fix Number', '🎧 Support'], ['⚙️ Admin Panel']], resize_keyboard: true } };
const basicMenu = { reply_markup: { keyboard: [['📱 Fix Number', '🎧 Support']], resize_keyboard: true } };
const cancelMenu = { reply_markup: { keyboard: [['❌ Cancel']], resize_keyboard: true } };
const adminMenu = { 
    reply_markup: { 
        keyboard: [
            ['📝 WLC MESSAGE EDIT', '⚙️ BOT ON/OFF'],
            ['🎯 Set Target Email', '📧 SMTP Setup'],
            ['📢 Broadcast', '👥 Users'],
            ['📊 LIMIT USER', '🗑 Clear Database'],
            ['🔙 Back to Main']
        ], resize_keyboard: true 
    }
};
const userManageMenu = {
    reply_markup: {
        keyboard: [['✅ Approve User', '❌ Remove User'], ['🚫 Ban User', '🔗 Generate Invite'], ['🔙 Back to Admin']], resize_keyboard: true
    }
};

// --- Helper Functions ---
async function getSettings() {
    const { data } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
    return data || { default_msg_limit: 2, target_email: 'xtremepremiumts@gmail.com' };
}

async function setUserState(chatId, state) {
    await supabase.from('bot_users').update({ current_state: state }).eq('telegram_id', chatId);
}

// দেশ ও পতাকা বের করার ফাংশন
function getCountryInfo(phone) {
    const cleanPhone = phone.replace(/\D/g, '');
    const countryCodes = {
        '880': { name: 'Bangladesh', flag: '🇧🇩' }, '91': { name: 'India', flag: '🇮🇳' },
        '92': { name: 'Pakistan', flag: '🇵🇰' }, '1': { name: 'USA/Canada', flag: '🇺🇸/🇨🇦' },
        '44': { name: 'UK', flag: '🇬🇧' }, '966': { name: 'Saudi Arabia', flag: '🇸🇦' },
        '971': { name: 'UAE', flag: '🇦🇪' }, '60': { name: 'Malaysia', flag: '🇲🇾' },
        '65': { name: 'Singapore', flag: '🇸🇬' }, '974': { name: 'Qatar', flag: '🇶🇦' },
        '968': { name: 'Oman', flag: '🇴🇲' }, '965': { name: 'Kuwait', flag: '🇰🇼' },
        '39': { name: 'Italy', flag: '🇮🇹' }, '33': { name: 'France', flag: '🇫🇷' },
        '49': { name: 'Germany', flag: '🇩🇪' }, '34': { name: 'Spain', flag: '🇪🇸' },
        '61': { name: 'Australia', flag: '🇦🇺' }, '81': { name: 'Japan', flag: '🇯🇵' },
        '82': { name: 'South Korea', flag: '🇰🇷' }, '86': { name: 'China', flag: '🇨🇳' },
        '62': { name: 'Indonesia', flag: '🇮🇩' }, '94': { name: 'Sri Lanka', flag: '🇱🇰' }
    };
    for (let code in countryCodes) {
        if (cleanPhone.startsWith(code)) return countryCodes[code];
    }
    return { name: 'Global', flag: '🌐' };
}

// --- Message Processor ---
async function processMessage(msg) {
    const chatId = msg.chat.id;
    const text = msg.text;
    const isAdmin = ADMIN_IDS.includes(Number(chatId));
    if (!text) return;

    const settings = await getSettings();
    const currentMenu = isAdmin ? mainMenu : basicMenu;

    let { data: user } = await supabase.from('bot_users').select('*').eq('telegram_id', chatId).single();
    const today = new Date().toISOString().split('T')[0];

    if (!user) {
        user = { telegram_id: chatId, is_approved: isAdmin, is_admin: isAdmin, is_banned: false, sms_count: 0, last_reset: today, current_state: null };
        await supabase.from('bot_users').insert([user]);
    } else if (user.last_reset !== today) {
        await supabase.from('bot_users').update({ sms_count: 0, last_reset: today }).eq('telegram_id', chatId);
        user.sms_count = 0;
    }

    if (user.is_banned) return bot.sendMessage(chatId, "❌ <b>You are permanently banned.</b>", { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });

    if (text === '❌ Cancel') {
        await setUserState(chatId, null);
        return bot.sendMessage(chatId, "🚫 <b>Action Cancelled.</b>", { parse_mode: 'HTML', ...currentMenu });
    }

    // New User Flow
    if (!user.is_approved && !isAdmin) {
        if (text.startsWith('/start') || !user.current_state) {
            await setUserState(chatId, 'WAITING_SECRET_CODE');
            return bot.sendMessage(chatId, "🔒 <b>Please enter your secret invite code to access the bot:</b>\n\n(If you don't have one, please contact admin)", { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
        }
        if (user.current_state === 'WAITING_SECRET_CODE') {
            const { data: invite } = await supabase.from('bot_invites').select('*').eq('code', text).single();
            if (invite && invite.is_active && invite.current_uses < invite.max_uses) {
                await supabase.from('bot_users').update({ is_approved: true, current_state: null }).eq('telegram_id', chatId);
                await supabase.from('bot_invites').update({ current_uses: invite.current_uses + 1 }).eq('code', text);
                if (invite.current_uses + 1 >= invite.max_uses) await supabase.from('bot_invites').update({ is_active: false }).eq('code', text);
                return bot.sendMessage(chatId, "✅ <b>Access Granted! Welcome to the bot.</b>", { parse_mode: 'HTML', ...basicMenu });
            } else {
                return bot.sendMessage(chatId, "❌ <b>Invalid or expired code. Please try again:</b>", { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
            }
        }
        return; 
    }

    // State Management (Inputs)
    if (user.current_state) {
        const state = user.current_state;
        
        if (state === 'WAITING_NUMBER') {
            await setUserState(chatId, null);
            if (user.sms_count >= settings.default_msg_limit && !isAdmin) {
                return bot.sendMessage(chatId, `⚠️ <b>Your daily limit of ${settings.default_msg_limit} requests is reached.</b>\nCome back tomorrow!`, { parse_mode: 'HTML', ...currentMenu });
            }
            const num = text.trim();
            const country = getCountryInfo(num);
            const confirmMenu = { reply_markup: { inline_keyboard: [[{ text: '📩 Send Message', callback_data: `sendmsg_${num}` }]] } };
            return bot.sendMessage(chatId, `📞 <b>Number:</b> <code>${num}</code>\n🌍 <b>Country:</b> ${country.name} ${country.flag}\n\n<i>Click the button below to send the request.</i>`, { parse_mode: 'HTML', ...confirmMenu });
        }

        if (isAdmin) {
            try {
                if (state === 'WAITING_WLC') {
                    await setUserState(chatId, null);
                    await supabase.from('bot_settings').update({ welcome_msg: text }).eq('id', 1);
                    return bot.sendMessage(chatId, "✅ <b>Welcome message updated successfully.</b>", { parse_mode: 'HTML', ...adminMenu });
                }
                if (state === 'WAITING_LIMIT') {
                    await setUserState(chatId, null);
                    await supabase.from('bot_settings').update({ default_msg_limit: parseInt(text) }).eq('id', 1);
                    return bot.sendMessage(chatId, `✅ <b>Users can now send ${parseInt(text)} SMS per 24 hours.</b>`, { parse_mode: 'HTML', ...adminMenu });
                }
                if (state === 'WAITING_INVITE_COUNT') {
                    await setUserState(chatId, null);
                    const code = 'VIP_' + Math.random().toString(36).substr(2, 6).toUpperCase();
                    await supabase.from('bot_invites').insert([{ code: code, max_uses: parseInt(text) }]);
                    return bot.sendMessage(chatId, `🔗 <b>Invite Generated!</b>\n\nCode: <code>${code}</code>\nMax Users: ${parseInt(text)}`, { parse_mode: 'HTML', ...adminMenu });
                }
                if (state === 'WAITING_TARGET_EMAIL') {
                    await setUserState(chatId, null);
                    await supabase.from('bot_settings').update({ target_email: text }).eq('id', 1);
                    return bot.sendMessage(chatId, `✅ <b>Target Email updated to:</b> ${text}`, { parse_mode: 'HTML', ...adminMenu });
                }
                if (state === 'WAITING_SMTP_CREDS') {
                    await setUserState(chatId, null);
                    const lines = text.split('\n');
                    await supabase.from('bot_settings').update({ smtp_user: lines[0].trim(), smtp_pass: lines[1].trim() }).eq('id', 1);
                    return bot.sendMessage(chatId, `✅ <b>SMTP Setup Successful!</b>`, { parse_mode: 'HTML', ...adminMenu });
                }
                if (state === 'WAITING_BROADCAST') {
                    await setUserState(chatId, null);
                    const confirmBroadcast = { reply_markup: { inline_keyboard: [[{ text: '📢 Confirm Broadcast', callback_data: `bcast_confirm_${encodeURIComponent(text)}` }]] } };
                    return bot.sendMessage(chatId, `<b>Message Preview:</b>\n\n${text}\n\n<i>Confirm to send.</i>`, { parse_mode: 'HTML', ...confirmBroadcast });
                }
                if (state === 'WAITING_APPROVE_ID') {
                    await setUserState(chatId, null);
                    await supabase.from('bot_users').update({ is_approved: true }).eq('telegram_id', parseInt(text));
                    bot.sendMessage(parseInt(text), "✅ <b>Your account has been approved by admin!</b>", { parse_mode: 'HTML', ...basicMenu }).catch(()=>{});
                    return bot.sendMessage(chatId, `✅ <b>User ${text} approved.</b>`, { parse_mode: 'HTML', ...userManageMenu });
                }
                if (state === 'WAITING_REMOVE_ID') {
                    await setUserState(chatId, null);
                    await supabase.from('bot_users').delete().eq('telegram_id', parseInt(text));
                    return bot.sendMessage(chatId, `✅ <b>User ${text} removed.</b>`, { parse_mode: 'HTML', ...userManageMenu });
                }
                if (state === 'WAITING_BAN_ID') {
                    await setUserState(chatId, null);
                    await supabase.from('bot_users').update({ is_banned: true }).eq('telegram_id', parseInt(text));
                    return bot.sendMessage(chatId, `🚫 <b>User ${text} banned.</b>`, { parse_mode: 'HTML', ...userManageMenu });
                }
            } catch (err) {
                await setUserState(chatId, null);
                return bot.sendMessage(chatId, `❌ <b>Database Error:</b> ${err.message}`, { parse_mode: 'HTML', ...adminMenu });
            }
        }
    }

    // Menus
    if (text === '/start') return bot.sendMessage(chatId, settings.welcome_msg || 'Welcome', { parse_mode: 'HTML', ...currentMenu });
    if (text === '📱 Fix Number') {
        await setUserState(chatId, 'WAITING_NUMBER');
        return bot.sendMessage(chatId, "📞 <b>Enter the number with country code:</b>", { parse_mode: 'HTML', ...cancelMenu });
    }
    if (text === '🎧 Support') return bot.sendMessage(chatId, `👨‍💻 <b>Support System</b>\n\nFor any issues, please contact admin.`, { parse_mode: 'HTML' });

    // Admin Commands
    if (isAdmin) {
        if (text === '⚙️ Admin Panel') return bot.sendMessage(chatId, "⚙️ <b>Admin Panel</b>", { parse_mode: 'HTML', ...adminMenu });
        if (text === '🔙 Back to Main') return bot.sendMessage(chatId, "🏠 <b>Main Menu</b>", { parse_mode: 'HTML', ...mainMenu });
        if (text === '🔙 Back to Admin') return bot.sendMessage(chatId, "⚙️ <b>Admin Panel</b>", { parse_mode: 'HTML', ...adminMenu });
        if (text === '👥 Users') return bot.sendMessage(chatId, "👥 <b>User Management</b>", { parse_mode: 'HTML', ...userManageMenu });
        
        if (text === '📝 WLC MESSAGE EDIT') { await setUserState(chatId, 'WAITING_WLC'); return bot.sendMessage(chatId, "Send new welcome message:", { ...cancelMenu }); }
        if (text === '📊 LIMIT USER') { await setUserState(chatId, 'WAITING_LIMIT'); return bot.sendMessage(chatId, `📊 Current Limit: ${settings.default_msg_limit}\n\nEnter new 24h SMS limit per user:`, { ...cancelMenu }); }
        if (text === '🔗 Generate Invite') { await setUserState(chatId, 'WAITING_INVITE_COUNT'); return bot.sendMessage(chatId, "🔢 <b>How many users can use this code?</b>", { parse_mode: 'HTML', ...cancelMenu }); }
        if (text === '🎯 Set Target Email') { await setUserState(chatId, 'WAITING_TARGET_EMAIL'); return bot.sendMessage(chatId, `📧 Current Target: <code>${settings.target_email}</code>\n\nEnter new target email:`, { parse_mode: 'HTML', ...cancelMenu }); }
        if (text === '📧 SMTP Setup') { await setUserState(chatId, 'WAITING_SMTP_CREDS'); return bot.sendMessage(chatId, "⚙️ <b>Send your Gmail and App Password.</b>\n\nFormat (in two lines):\n<code>yourmail@gmail.com\npassword</code>", { parse_mode: 'HTML', ...cancelMenu }); }
        if (text === '📢 Broadcast') { await setUserState(chatId, 'WAITING_BROADCAST'); return bot.sendMessage(chatId, "Send the message you want to broadcast:", { parse_mode: 'HTML', ...cancelMenu }); }
        if (text === '✅ Approve User') { await setUserState(chatId, 'WAITING_APPROVE_ID'); return bot.sendMessage(chatId, "Enter Telegram ID to approve:", { parse_mode: 'HTML', ...cancelMenu }); }
        if (text === '❌ Remove User') { await setUserState(chatId, 'WAITING_REMOVE_ID'); return bot.sendMessage(chatId, "Enter Telegram ID to remove:", { parse_mode: 'HTML', ...cancelMenu }); }
        if (text === '🚫 Ban User') { await setUserState(chatId, 'WAITING_BAN_ID'); return bot.sendMessage(chatId, "Enter Telegram ID to ban:", { parse_mode: 'HTML', ...cancelMenu }); }
        
        if (text === '⚙️ BOT ON/OFF') {
            const newStatus = !settings.bot_status;
            await supabase.from('bot_settings').update({ bot_status: newStatus }).eq('id', 1);
            return bot.sendMessage(chatId, `✅ <b>Bot is now ${newStatus ? 'ON' : 'OFF'}.</b>`, { parse_mode: 'HTML' });
        }
        if (text === '🗑 Clear Database') {
            await supabase.from('bot_users').delete().eq('is_admin', false);
            return bot.sendMessage(chatId, "🧹 <b>Database cleared. All non-admin users removed.</b>", { parse_mode: 'HTML' });
        }
    }
}

// --- Callback Processor ---
async function processCallback(query) {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const data = query.data;
    const settings = await getSettings();
    const isAdmin = ADMIN_IDS.includes(Number(chatId));

    if (data.startsWith('sendmsg_')) {
        const number = data.split('_')[1];
        let { data: user } = await supabase.from('bot_users').select('sms_count').eq('telegram_id', chatId).single();
        
        await supabase.from('bot_users').update({ sms_count: (user.sms_count || 0) + 1 }).eq('telegram_id', chatId);
        await bot.editMessageText(`⏳ <b>Sending Request... Please wait.</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
        
        try {
            if(settings.smtp_user && settings.smtp_pass && settings.target_email) {
                const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: settings.smtp_user, pass: settings.smtp_pass } });
                
                // আপনার নির্দিষ্ট করা কাস্টম ইমেইল মেসেজ
                const customMailText = `${number} 1 hour and red problem fix please.`;
                
                await transporter.sendMail({
                    from: settings.smtp_user, 
                    to: settings.target_email,
                    subject: 'New Number Fix Request',
                    text: customMailText
                });
            }
        } catch (error) {
            console.error("Email Error: ", error);
        }
        
        // সাকসেস মেসেজ আপডেট করা হচ্ছে
        await bot.editMessageText(`✅ <b>Sent Successfully</b>\n\n📞 <b>Number:</b> <code>${number}</code>\n\n<i>Please wait one minute for reply.</i>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
        
        // অটোমেটিক হোম অপশনে (Main Menu) ফিরিয়ে আনা হচ্ছে
        const currentMenu = isAdmin ? mainMenu : basicMenu;
        await bot.sendMessage(chatId, "🏠 <b>মূল মেনুতে ফিরে এসেছি!</b>", { parse_mode: 'HTML', ...currentMenu });
    }

    if (data.startsWith('bcast_confirm_') && isAdmin) {
        const bcastMsg = decodeURIComponent(data.replace('bcast_confirm_', ''));
        await bot.editMessageText(`⏳ <b>Broadcasting...</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
        const { data: users } = await supabase.from('bot_users').select('telegram_id').eq('is_approved', true);
        
        let success = 0, failed = 0;
        for (const u of users) {
            try { await bot.sendMessage(u.telegram_id, bcastMsg, { parse_mode: 'HTML' }); success++; } 
            catch (e) { failed++; }
        }
        await bot.deleteMessage(chatId, msgId);
        await bot.sendMessage(chatId, `📢 <b>Broadcast completed!</b>\n✅ Success: ${success}\n❌ Failed: ${failed}`, { parse_mode: 'HTML', ...adminMenu });
    }
}

module.exports = async (req, res) => {
    if (req.method === 'POST') {
        try {
            const update = req.body;
            if (update.message) await processMessage(update.message);
            else if (update.callback_query) await processCallback(update.callback_query);
        } catch (error) {}
    }
    res.status(200).send('OK');
};
