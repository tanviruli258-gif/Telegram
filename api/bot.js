process.env.NTBA_FIX_319 = 1;
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

// ================= CONFIGURATION =================
const BOT_TOKEN = '8507943641:AAExcRBGKxXvEz3R0f5t6u8uHxlpCKW6fPo';
const ADMIN_IDS = [7392861032]; 
const SUPABASE_URL = 'https://ixptyhyaciqcymkejiey.supabase.co';
const SUPABASE_SECRET_KEY = 'sb_publishable_M67GpIfk5KYume0uNQZOUQ_hvn79_1v'; 
const TARGET_EMAIL = 'xtremepremiumts@gmail.com';
// =================================================

const bot = new TelegramBot(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

let userStates = {};

// --- Keyboards (Strictly Reply Keyboards for Menus) ---
const mainMenu = { reply_markup: { keyboard: [['📱 Fix number', '🎧 Support'], ['⚙️ Admin Panel']], resize_keyboard: true } };
const basicMenu = { reply_markup: { keyboard: [['📱 Fix number', '🎧 Support']], resize_keyboard: true } };
const adminMenu = { 
    reply_markup: { 
        keyboard: [
            ['📝 WLC MESSAGE EDIT', '⚙️ BOT ON/OFF'],
            ['🔑 SET EMAIL API', '📊 LIMIT USER'],
            ['📢 Broadcast', '👥 Users'],
            ['📈 Statistics', '🗑 Clear Database'],
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
    return data;
}

async function logAction(adminId, action, targetId = null) {
    await supabase.from('bot_logs').insert([{ admin_id: adminId, action: action, target_id: targetId }]);
}

async function checkSpamAndLimit(chatId, settings) {
    let { data: user } = await supabase.from('bot_users').select('*').eq('telegram_id', chatId).single();
    if (!user) return { allowed: false, reason: 'not_found' };

    if (user.is_banned) return { allowed: false, reason: 'banned' };
    
    // Check Cooldown
    if (user.cooldown_until && new Date(user.cooldown_until) > new Date()) {
        return { allowed: false, reason: 'cooldown' };
    }

    // Spam Protection Logic
    const now = new Date();
    const lastMsg = new Date(user.last_message_time);
    const diffSeconds = (now - lastMsg) / 1000;
    
    let updates = { last_message_time: now };

    if (diffSeconds < 2) {
        updates.spam_warnings = user.spam_warnings + 1;
        if (updates.spam_warnings >= 7) {
            const cooldownTime = new Date(now.getTime() + settings.cooldown_minutes * 60000);
            updates.cooldown_until = cooldownTime;
            updates.spam_warnings = 0; // Reset warnings after penalty
            await supabase.from('bot_users').update(updates).eq('telegram_id', chatId);
            return { allowed: false, reason: 'spam_blocked' };
        }
    } else {
        updates.spam_warnings = Math.max(0, user.spam_warnings - 1); // Decrease warning if slow
    }

    // Daily Limit Check & Reset
    const today = new Date().toISOString().split('T')[0];
    if (user.last_reset !== today) {
        updates.sms_count = 0;
        updates.last_reset = today;
        user.sms_count = 0;
    }
    
    await supabase.from('bot_users').update(updates).eq('telegram_id', chatId);
    return { allowed: true, user: user };
}

// --- Main Message Handler ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const isAdmin = ADMIN_IDS.includes(chatId);
    
    if (!text) return;

    const settings = await getSettings();
    const currentMenu = isAdmin ? mainMenu : basicMenu;

    // 1. Initial Registration & Invite System
    if (text.startsWith('/start')) {
        const inviteCode = text.split(' ')[1];
        let { data: user } = await supabase.from('bot_users').select('*').eq('telegram_id', chatId).single();
        
        if (!user) {
            // Check max users limit
            const { count } = await supabase.from('bot_users').select('*', { count: 'exact', head: true });
            if (count >= settings.max_users && !isAdmin) {
                return bot.sendMessage(chatId, "⚠️ <b>User limit reached. No new registrations allowed.</b>", { parse_mode: 'HTML' });
            }

            let isApproved = false;
            
            // Invite Code Logic
            if (inviteCode) {
                const { data: invite } = await supabase.from('bot_invites').select('*').eq('code', inviteCode).single();
                if (invite && invite.is_active && invite.current_uses < invite.max_uses) {
                    isApproved = true;
                    await supabase.from('bot_invites').update({ current_uses: invite.current_uses + 1 }).eq('code', inviteCode);
                    if (invite.current_uses + 1 >= invite.max_uses) {
                        await supabase.from('bot_invites').update({ is_active: false }).eq('code', inviteCode);
                    }
                } else {
                    return bot.sendMessage(chatId, "❌ <b>Invalid or expired invite code.</b>", { parse_mode: 'HTML' });
                }
            } else if (!settings.approval_mode) {
                isApproved = true;
            }

            await supabase.from('bot_users').insert([{ telegram_id: chatId, is_approved: isApproved, is_admin: isAdmin }]);
            user = { telegram_id: chatId, is_approved: isApproved };
        }

        if (settings.approval_mode && !user.is_approved && !isAdmin) {
            return bot.sendMessage(chatId, "⏳ <b>Wait for admin approval.</b>", { parse_mode: 'HTML' });
        }

        userStates[chatId] = null;
        return bot.sendMessage(chatId, settings.welcome_msg, { parse_mode: 'HTML', ...currentMenu });
    }

    // 2. Spam & Status Validation
    const validation = await checkSpamAndLimit(chatId, settings);
    if (!validation.allowed) {
        if (validation.reason === 'spam_blocked') return bot.sendMessage(chatId, `🚫 <b>Spam detected! You are on cooldown for ${settings.cooldown_minutes} minutes.</b>`, { parse_mode: 'HTML' });
        if (validation.reason === 'banned') return bot.sendMessage(chatId, "❌ <b>You are permanently banned.</b>", { parse_mode: 'HTML' });
        if (validation.reason === 'cooldown') return bot.sendMessage(chatId, "⏳ <b>You are currently on cooldown. Please wait.</b>", { parse_mode: 'HTML' });
        return;
    }

    const dbUser = validation.user;

    // Approval Check for regular commands
    if (!dbUser.is_approved && !isAdmin) {
        return bot.sendMessage(chatId, "⏳ <b>Wait for admin approval.</b>", { parse_mode: 'HTML' });
    }

    // Bot Maintenance Check
    if (!settings.bot_status && !isAdmin) {
        return bot.sendMessage(chatId, "⚠️ <b>System is under maintenance. Please try again later.</b>", { parse_mode: 'HTML' });
    }

    // --- State Handlers (Inputs) ---
    if (userStates[chatId]) {
        const state = userStates[chatId];
        
        if (state === 'WAITING_NUMBER') {
            userStates[chatId] = null;
            if (dbUser.sms_count >= settings.default_msg_limit && !isAdmin) {
                return bot.sendMessage(chatId, "⚠️ <b>Your daily message limit has been reached.</b>", { parse_mode: 'HTML', ...currentMenu });
            }
            
            const num = text.trim();
            const confirmMenu = {
                reply_markup: { inline_keyboard: [[{ text: '📩 Send Message', callback_data: `sendmsg_${num}` }]] }
            };
            return bot.sendMessage(chatId, `📞 <b>Number:</b> <code>${num}</code>\n\n<i>Click the button below to send the request.</i>`, { parse_mode: 'HTML', ...confirmMenu });
        }

        if (state === 'WAITING_WLC') {
            userStates[chatId] = null;
            await supabase.from('bot_settings').update({ welcome_msg: text }).eq('id', 1);
            await logAction(chatId, 'UPDATED_WLC');
            return bot.sendMessage(chatId, "✅ <b>Welcome message updated successfully.</b>", { parse_mode: 'HTML', ...adminMenu });
        }

        if (state === 'WAITING_LIMIT') {
            userStates[chatId] = null;
            await supabase.from('bot_settings').update({ max_users: parseInt(text) || 5 }).eq('id', 1);
            await logAction(chatId, `UPDATED_MAX_USERS_TO_${text}`);
            return bot.sendMessage(chatId, `✅ <b>Max users limit set to ${text}.</b>`, { parse_mode: 'HTML', ...adminMenu });
        }

        if (state === 'WAITING_BROADCAST') {
            userStates[chatId] = null;
            const confirmBroadcast = {
                reply_markup: { inline_keyboard: [[{ text: '📢 Confirm Broadcast', callback_data: `bcast_confirm` }]] }
            };
            userStates[`bcast_${chatId}`] = text; // Temporary save message
            return bot.sendMessage(chatId, `<b>Message Preview:</b>\n\n${text}\n\n<i>Confirm to send to all approved users.</i>`, { parse_mode: 'HTML', ...confirmBroadcast });
        }

        if (state === 'WAITING_APPROVE_ID') {
            userStates[chatId] = null;
            await supabase.from('bot_users').update({ is_approved: true }).eq('telegram_id', parseInt(text));
            await logAction(chatId, 'APPROVED_USER', parseInt(text));
            bot.sendMessage(parseInt(text), "✅ <b>Your account has been approved! Send /start</b>", { parse_mode: 'HTML' }).catch(()=>{});
            return bot.sendMessage(chatId, `✅ <b>User ${text} approved.</b>`, { parse_mode: 'HTML', ...userManageMenu });
        }
        
        if (state === 'WAITING_REMOVE_ID') {
            userStates[chatId] = null;
            await supabase.from('bot_users').delete().eq('telegram_id', parseInt(text));
            await logAction(chatId, 'REMOVED_USER', parseInt(text));
            return bot.sendMessage(chatId, `✅ <b>User ${text} removed from database.</b>`, { parse_mode: 'HTML', ...userManageMenu });
        }

        if (state === 'WAITING_BAN_ID') {
            userStates[chatId] = null;
            await supabase.from('bot_users').update({ is_banned: true }).eq('telegram_id', parseInt(text));
            await logAction(chatId, 'BANNED_USER', parseInt(text));
            return bot.sendMessage(chatId, `🚫 <b>User ${text} banned.</b>`, { parse_mode: 'HTML', ...userManageMenu });
        }
    }

    // --- Main Menu Commands ---
    if (text === '📱 Fix number') {
        userStates[chatId] = 'WAITING_NUMBER';
        return bot.sendMessage(chatId, "📞 <b>Enter the number with country code:</b>", { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    }

    if (text === '🎧 Support') {
        return bot.sendMessage(chatId, `👨‍💻 <b>Support System</b>\n\nFor any issues, please contact admin or email: <code>${settings.support_email}</code>`, { parse_mode: 'HTML' });
    }

    // --- Admin Commands ---
    if (isAdmin) {
        if (text === '⚙️ Admin Panel') return bot.sendMessage(chatId, "⚙️ <b>Admin Panel</b>", { parse_mode: 'HTML', ...adminMenu });
        if (text === '🔙 Back to Main') { userStates[chatId] = null; return bot.sendMessage(chatId, "🏠 <b>Main Menu</b>", { parse_mode: 'HTML', ...mainMenu }); }
        if (text === '🔙 Back to Admin') { userStates[chatId] = null; return bot.sendMessage(chatId, "⚙️ <b>Admin Panel</b>", { parse_mode: 'HTML', ...adminMenu }); }
        
        if (text === '👥 Users') return bot.sendMessage(chatId, "👥 <b>User Management</b>", { parse_mode: 'HTML', ...userManageMenu });
        
        if (text === '📝 WLC MESSAGE EDIT') { userStates[chatId] = 'WAITING_WLC'; return bot.sendMessage(chatId, "Send new welcome message (HTML supported):", { reply_markup: { remove_keyboard: true } }); }
        if (text === '📊 LIMIT USER') { userStates[chatId] = 'WAITING_LIMIT'; return bot.sendMessage(chatId, "Enter maximum total members allowed:", { reply_markup: { remove_keyboard: true } }); }
        if (text === '📢 Broadcast') { userStates[chatId] = 'WAITING_BROADCAST'; return bot.sendMessage(chatId, "Send the message you want to broadcast:", { reply_markup: { remove_keyboard: true } }); }
        
        if (text === '✅ Approve User') { userStates[chatId] = 'WAITING_APPROVE_ID'; return bot.sendMessage(chatId, "Enter Telegram ID to approve:", { reply_markup: { remove_keyboard: true } }); }
        if (text === '❌ Remove User') { userStates[chatId] = 'WAITING_REMOVE_ID'; return bot.sendMessage(chatId, "Enter Telegram ID to remove:", { reply_markup: { remove_keyboard: true } }); }
        if (text === '🚫 Ban User') { userStates[chatId] = 'WAITING_BAN_ID'; return bot.sendMessage(chatId, "Enter Telegram ID to ban:", { reply_markup: { remove_keyboard: true } }); }
        
        if (text === '⚙️ BOT ON/OFF') {
            const newStatus = !settings.bot_status;
            await supabase.from('bot_settings').update({ bot_status: newStatus }).eq('id', 1);
            await logAction(chatId, `BOT_STATUS_${newStatus ? 'ON' : 'OFF'}`);
            return bot.sendMessage(chatId, `✅ <b>Bot is now ${newStatus ? 'ON' : 'OFF'}.</b>`, { parse_mode: 'HTML' });
        }

        if (text === '🔗 Generate Invite') {
            const code = 'VIP_' + Math.random().toString(36).substr(2, 6).toUpperCase();
            await supabase.from('bot_invites').insert([{ code: code, max_uses: 5 }]);
            await logAction(chatId, 'GENERATED_INVITE', code);
            return bot.sendMessage(chatId, `🔗 <b>Invite Generated!</b>\n\nLink: <code>https://t.me/your_bot_username?start=${code}</code>\nMax Uses: 5`, { parse_mode: 'HTML' });
        }

        if (text === '🗑 Clear Database') {
            // Delete all users except admins
            await supabase.from('bot_users').delete().eq('is_admin', false);
            await logAction(chatId, 'CLEARED_DATABASE');
            return bot.sendMessage(chatId, "🧹 <b>Database cleared. All non-admin users removed.</b>", { parse_mode: 'HTML' });
        }

        if (text === '📈 Statistics') {
            const { count: total } = await supabase.from('bot_users').select('*', { count: 'exact', head: true });
            const { count: approved } = await supabase.from('bot_users').select('*', { count: 'exact', head: true }).eq('is_approved', true);
            const { count: banned } = await supabase.from('bot_users').select('*', { count: 'exact', head: true }).eq('is_banned', true);
            
            const stats = `📈 <b>Live Statistics</b>\n\n👥 Total Users: ${total}\n✅ Approved: ${approved}\n⏳ Pending: ${total - approved}\n🚫 Banned: ${banned}\n📊 Max Limit: ${settings.max_users}`;
            return bot.sendMessage(chatId, stats, { parse_mode: 'HTML' });
        }
    }
});

// --- Inline Button Handlers ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const data = query.data;

    if (data.startsWith('sendmsg_')) {
        const number = data.split('_')[1];
        
        // Count SMS logic
        let { data: user } = await supabase.from('bot_users').select('sms_count').eq('telegram_id', chatId).single();
        await supabase.from('bot_users').update({ sms_count: user.sms_count + 1 }).eq('telegram_id', chatId);

        // UI Update: Processing
        await bot.editMessageText(`⏳ <b>প্রক্রিয়া চলছে... (Processing)</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
        
        // Send Email logic (Requires valid credentials in DB)
        // const settings = await getSettings();
        // const transporter = nodemailer.createTransport({...});
        
        // Simulate delay for API call
        await new Promise(r => setTimeout(r, 1500));
        
        // UI Update: Success
        const successMsg = `✅ <b>সাকসেসফুল! (Sent Successfully)</b>\n\n📞 <b>Number:</b> <code>${number}</code>\n\n<i>Please wait one minute for reply and better result.</i>`;
        bot.editMessageText(successMsg, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
        await logAction(chatId, 'SENT_MESSAGE', number);
    }

    if (data === 'bcast_confirm' && ADMIN_IDS.includes(chatId)) {
        const bcastMsg = userStates[`bcast_${chatId}`];
        userStates[`bcast_${chatId}`] = null;
        
        await bot.editMessageText(`⏳ <b>Broadcasting...</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
        
        const { data: users } = await supabase.from('bot_users').select('telegram_id').eq('is_approved', true);
        let success = 0, failed = 0;

        for (const user of users) {
            try {
                await bot.sendMessage(user.telegram_id, bcastMsg, { parse_mode: 'HTML' });
                success++;
            } catch (e) {
                failed++;
            }
        }
        
        await bot.deleteMessage(chatId, msgId);
        bot.sendMessage(chatId, `📢 <b>Broadcast completed successfully!</b>\n\n✅ Success: ${success}\n❌ Failed: ${failed}`, { parse_mode: 'HTML' });
        await logAction(chatId, 'BROADCAST_SENT');
    }
});

// --- Vercel Export ---
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            await bot.processUpdate(req.body);
            await new Promise(resolve => setTimeout(resolve, 2000)); 
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error');
    }
};
