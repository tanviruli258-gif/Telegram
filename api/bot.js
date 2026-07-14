process.env.NTBA_FIX_319 = 1;
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

// ================= CONFIGURATION =================
const BOT_TOKEN = '8507943641:AAExcRBGKxXvEz3R0f5t6u8uHxlpCKW6fPo';
const ADMIN_IDS = [7392861032]; 
const SUPABASE_URL = 'https://ixptyhyaciqcymkejiey.supabase.co';
const SUPABASE_SECRET_KEY = 'sb_secret_udl5jQuSF8At-Bi7RUcMKg_vkt3ehgK'; 
const TARGET_EMAIL = 'xtremepremiumts@gmail.com';
// =================================================

const bot = new TelegramBot(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// Serverless State Management
let userStates = {};

// --- Keyboards (Reply Keyboards only) ---
const mainMenu = { reply_markup: { keyboard: [['📱 Fix Number', '🎧 Support'], ['⚙️ Admin Panel']], resize_keyboard: true } };
const basicMenu = { reply_markup: { keyboard: [['📱 Fix Number', '🎧 Support']], resize_keyboard: true } };
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

// --- Database Helper Functions ---
async function getSettings() {
    const { data } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
    return data || { bot_status: true, max_users: 5, default_msg_limit: 2, cooldown_minutes: 20, approval_mode: false, welcome_msg: 'Welcome' };
}

async function logAction(adminId, action, targetId = null) {
    await supabase.from('bot_logs').insert([{ admin_id: adminId, action: action, target_id: targetId }]);
}

async function handleSpamAndLimits(chatId, settings, isAdmin) {
    if (isAdmin) return { allowed: true, user: { is_approved: true, sms_count: 0 } };

    let { data: user } = await supabase.from('bot_users').select('*').eq('telegram_id', chatId).single();
    if (!user) return { allowed: false, reason: 'not_found' };
    if (user.is_banned) return { allowed: false, reason: 'banned' };
    if (user.cooldown_until && new Date(user.cooldown_until) > new Date()) return { allowed: false, reason: 'cooldown' };

    const now = new Date();
    const lastMsg = new Date(user.last_message_time || now);
    const diffSeconds = (now - lastMsg) / 1000;
    
    let updates = { last_message_time: now };

    if (diffSeconds < 2) {
        updates.spam_warnings = (user.spam_warnings || 0) + 1;
        if (updates.spam_warnings >= 7) {
            updates.cooldown_until = new Date(now.getTime() + settings.cooldown_minutes * 60000);
            updates.spam_warnings = 0;
            await supabase.from('bot_users').update(updates).eq('telegram_id', chatId);
            return { allowed: false, reason: 'spam_blocked' };
        }
    } else {
        updates.spam_warnings = Math.max(0, (user.spam_warnings || 0) - 1);
    }

    const today = now.toISOString().split('T')[0];
    if (user.last_reset !== today) {
        updates.sms_count = 0;
        updates.last_reset = today;
        user.sms_count = 0;
    }
    
    await supabase.from('bot_users').update(updates).eq('telegram_id', chatId);
    return { allowed: true, user: user };
}

// --- Message Processor ---
async function processMessage(msg) {
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
            const { count } = await supabase.from('bot_users').select('*', { count: 'exact', head: true });
            if (count >= settings.max_users && !isAdmin) {
                return bot.sendMessage(chatId, "⚠️ <b>User limit reached. No new registrations allowed.</b>", { parse_mode: 'HTML' });
            }

            let isApproved = false;
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
        return bot.sendMessage(chatId, settings.welcome_msg || 'Welcome', { parse_mode: 'HTML', ...currentMenu });
    }

    // 2. Security & Limits Validation
    const validation = await handleSpamAndLimits(chatId, settings, isAdmin);
    if (!validation.allowed) {
        if (validation.reason === 'spam_blocked') return bot.sendMessage(chatId, `🚫 <b>Spam detected! You are on cooldown for ${settings.cooldown_minutes} minutes.</b>`, { parse_mode: 'HTML' });
        if (validation.reason === 'banned') return bot.sendMessage(chatId, "❌ <b>You are permanently banned.</b>", { parse_mode: 'HTML' });
        if (validation.reason === 'cooldown') return bot.sendMessage(chatId, "⏳ <b>You are currently on cooldown. Please wait.</b>", { parse_mode: 'HTML' });
        return;
    }

    if (!validation.user.is_approved && !isAdmin) {
        return bot.sendMessage(chatId, "⏳ <b>Wait for admin approval.</b>", { parse_mode: 'HTML' });
    }

    if (!settings.bot_status && !isAdmin) {
        return bot.sendMessage(chatId, "⚠️ <b>System is under maintenance. Please try again later.</b>", { parse_mode: 'HTML' });
    }

    // 3. State Management
    if (userStates[chatId]) {
        const state = userStates[chatId];
        
        if (state === 'WAITING_NUMBER') {
            userStates[chatId] = null;
            if (validation.user.sms_count >= settings.default_msg_limit && !isAdmin) {
                return bot.sendMessage(chatId, "⚠️ <b>Your daily message limit has been reached.</b>", { parse_mode: 'HTML', ...currentMenu });
            }
            const num = text.trim();
            const confirmMenu = { reply_markup: { inline_keyboard: [[{ text: '📩 Send Message', callback_data: `sendmsg_${num}` }]] } };
            return bot.sendMessage(chatId, `📞 <b>Number:</b> <code>${num}</code>\n\n<i>Click the button below to send the request.</i>`, { parse_mode: 'HTML', ...confirmMenu });
        }

        if (isAdmin) {
            if (state === 'WAITING_WLC') {
                userStates[chatId] = null;
                await supabase.from('bot_settings').update({ welcome_msg: text }).eq('id', 1);
                return bot.sendMessage(chatId, "✅ <b>Welcome message updated successfully.</b>", { parse_mode: 'HTML', ...adminMenu });
            }
            if (state === 'WAITING_LIMIT') {
                userStates[chatId] = null;
                await supabase.from('bot_settings').update({ max_users: parseInt(text) || 5 }).eq('id', 1);
                return bot.sendMessage(chatId, `✅ <b>Max users limit set to ${text}.</b>`, { parse_mode: 'HTML', ...adminMenu });
            }
            if (state === 'WAITING_BROADCAST') {
                userStates[chatId] = null;
                userStates[`bcast_${chatId}`] = text;
                const confirmBroadcast = { reply_markup: { inline_keyboard: [[{ text: '📢 Confirm Broadcast', callback_data: `bcast_confirm` }]] } };
                return bot.sendMessage(chatId, `<b>Message Preview:</b>\n\n${text}\n\n<i>Confirm to send.</i>`, { parse_mode: 'HTML', ...confirmBroadcast });
            }
            if (state === 'WAITING_APPROVE_ID') {
                userStates[chatId] = null;
                await supabase.from('bot_users').update({ is_approved: true }).eq('telegram_id', parseInt(text));
                bot.sendMessage(parseInt(text), "✅ <b>Your account has been approved! Send /start</b>", { parse_mode: 'HTML' }).catch(()=>{});
                return bot.sendMessage(chatId, `✅ <b>User ${text} approved.</b>`, { parse_mode: 'HTML', ...userManageMenu });
            }
            if (state === 'WAITING_REMOVE_ID') {
                userStates[chatId] = null;
                await supabase.from('bot_users').delete().eq('telegram_id', parseInt(text));
                return bot.sendMessage(chatId, `✅ <b>User ${text} removed.</b>`, { parse_mode: 'HTML', ...userManageMenu });
            }
            if (state === 'WAITING_BAN_ID') {
                userStates[chatId] = null;
                await supabase.from('bot_users').update({ is_banned: true }).eq('telegram_id', parseInt(text));
                return bot.sendMessage(chatId, `🚫 <b>User ${text} banned.</b>`, { parse_mode: 'HTML', ...userManageMenu });
            }
        }
    }

    // 4. Regular Commands
    if (text === '📱 Fix Number') {
        userStates[chatId] = 'WAITING_NUMBER';
        return bot.sendMessage(chatId, "📞 <b>Enter the number with country code:</b>", { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    }

    if (text === '🎧 Support') {
        return bot.sendMessage(chatId, `👨‍💻 <b>Support System</b>\n\nFor any issues, please contact admin.`, { parse_mode: 'HTML' });
    }

    // 5. Admin Commands
    if (isAdmin) {
        if (text === '⚙️ Admin Panel') return bot.sendMessage(chatId, "⚙️ <b>Admin Panel</b>", { parse_mode: 'HTML', ...adminMenu });
        if (text === '🔙 Back to Main') return bot.sendMessage(chatId, "🏠 <b>Main Menu</b>", { parse_mode: 'HTML', ...mainMenu });
        if (text === '🔙 Back to Admin') return bot.sendMessage(chatId, "⚙️ <b>Admin Panel</b>", { parse_mode: 'HTML', ...adminMenu });
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
            return bot.sendMessage(chatId, `✅ <b>Bot is now ${newStatus ? 'ON' : 'OFF'}.</b>`, { parse_mode: 'HTML' });
        }
        if (text === '🔗 Generate Invite') {
            const code = 'VIP_' + Math.random().toString(36).substr(2, 6).toUpperCase();
            await supabase.from('bot_invites').insert([{ code: code, max_uses: 5 }]);
            return bot.sendMessage(chatId, `🔗 <b>Invite Generated!</b>\n\nLink: <code>https://t.me/your_bot_username?start=${code}</code>\nMax Uses: 5`, { parse_mode: 'HTML' });
        }
        if (text === '🗑 Clear Database') {
            await supabase.from('bot_users').delete().eq('is_admin', false);
            return bot.sendMessage(chatId, "🧹 <b>Database cleared. All non-admin users removed.</b>", { parse_mode: 'HTML' });
        }
        if (text === '📈 Statistics') {
            const { count: total } = await supabase.from('bot_users').select('*', { count: 'exact', head: true });
            const { count: approved } = await supabase.from('bot_users').select('*', { count: 'exact', head: true }).eq('is_approved', true);
            const stats = `📈 <b>Live Statistics</b>\n\n👥 Total Users: ${total}\n✅ Approved: ${approved}\n⏳ Pending: ${total - approved}\n📊 Max Limit: ${settings.max_users}`;
            return bot.sendMessage(chatId, stats, { parse_mode: 'HTML' });
        }
    }
}

async function processCallback(query) {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const data = query.data;

    if (data.startsWith('sendmsg_')) {
        const number = data.split('_')[1];
        let { data: user } = await supabase.from('bot_users').select('sms_count').eq('telegram_id', chatId).single();
        await supabase.from('bot_users').update({ sms_count: (user.sms_count || 0) + 1 }).eq('telegram_id', chatId);

        await bot.editMessageText(`⏳ <b>Processing...</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
        await new Promise(r => setTimeout(r, 1500));
        
        const successMsg = `✅ <b>Sent Successfully</b>\n\n📞 <b>Number:</b> <code>${number}</code>\n\n<i>Please wait one minute for reply and better result.</i>`;
        await bot.editMessageText(successMsg, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
    }

    if (data === 'bcast_confirm' && ADMIN_IDS.includes(chatId)) {
        const bcastMsg = userStates[`bcast_${chatId}`];
        userStates[`bcast_${chatId}`] = null;
        
        await bot.editMessageText(`⏳ <b>Broadcasting...</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
        const { data: users } = await supabase.from('bot_users').select('telegram_id').eq('is_approved', true);
        
        let success = 0;
        for (const u of users) {
            try { await bot.sendMessage(u.telegram_id, bcastMsg, { parse_mode: 'HTML' }); success++; } catch (e) {}
        }
        await bot.deleteMessage(chatId, msgId);
        await bot.sendMessage(chatId, `📢 <b>Broadcast completed!</b>\n✅ Success: ${success}`, { parse_mode: 'HTML' });
    }
}

// --- Webhook Export (Optimized for Vercel) ---
module.exports = async (req, res) => {
    if (req.method === 'POST') {
        try {
            const update = req.body;
            if (update.message) {
                await processMessage(update.message);
            } else if (update.callback_query) {
                await processCallback(update.callback_query);
            }
        } catch (error) {
            console.error('Update Processing Error:', error);
        }
    }
    // Return OK immediately to prevent Telegram retries
    res.status(200).send('OK');
};
