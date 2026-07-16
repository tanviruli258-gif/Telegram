process.env.NTBA_FIX_319 = 1;
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { authenticator } = require('otplib');

// ============================================================================
// 1. SYSTEM CONFIGURATIONS
// ============================================================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const SUPER_ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number) : []; 
const API_BASE_URL = 'https://api.2oo9.cloud/MXS47FLFX0U/tness/@public/api';

const bot = new TelegramBot(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// ============================================================================
// 2. PROFESSIONAL MENUS & UI
// ============================================================================
const getMainMenu = (isSuperAdmin, isSubAdmin) => {
    const kb = [['🚀 Get Number', '⚙️ Set Range'], ['🚦 Traffic', '🔐 2FA'], ['🎧 Support']];
    if (isSuperAdmin || isSubAdmin) kb.push(['👑 Admin Panel']);
    return { reply_markup: { keyboard: kb, resize_keyboard: true } };
};

// Super Admin gets everything, Sub Admin gets restricted view
const getAdminMenu = (isSuperAdmin) => {
    if (isSuperAdmin) {
        return { reply_markup: { keyboard: [
            ['📡 API Management', '🛡️ Sub-Admin'],
            ['⛔ Range Blacklist', '📢 Broadcast'],
            ['🔍 User Info', '📈 Global Stats'],
            ['🔴 Maintenance', '🔙 Back to Main']
        ], resize_keyboard: true } };
    } else {
        return { reply_markup: { keyboard: [
            ['📢 Broadcast', '📈 Global Stats'],
            ['🔍 User Info', '🔙 Back to Main']
        ], resize_keyboard: true } };
    }
};

const cancelMenu = { reply_markup: { keyboard: [['❌ Cancel']], resize_keyboard: true } };

// ============================================================================
// 3. CORE HELPER FUNCTIONS
// ============================================================================
async function getUser(chatId) {
    let { data: user } = await supabase.from('bot_users').select('*').eq('telegram_id', chatId).single();
    if (!user) {
        user = { telegram_id: chatId, saved_range: null, current_state: null, total_numbers: 0, total_otps: 0, is_admin: false, is_banned: false };
        await supabase.from('bot_users').insert([user]);
    }
    return user;
}

async function updateState(chatId, state) {
    await supabase.from('bot_users').update({ current_state: state }).eq('telegram_id', chatId);
}

function extractOTP(message) {
    const match = message.match(/\b\d{4,8}\b/);
    return match ? match[0] : message;
}

// 🚀 FAST NUMBER FETCHER (Replaces content in the SAME message)
async function fetchNumberAction(chatId, range, settings, editMsgId = null) {
    const blacklisted = (settings.blacklisted_ranges || '').split(',').map(r => r.trim().toUpperCase());
    if (blacklisted.includes(range.toUpperCase())) {
        const text = `🚫 <b>Range Blocked!</b>\nThe range <code>${range}</code> is currently restricted by the Admin.`;
        if (editMsgId) return bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: 'HTML' });
        return bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    }

    const waitText = `⏳ <b>Allocating new number from <code>${range}</code>...</b>`;
    let msgIdToEdit = editMsgId;
    
    if (editMsgId) {
        await bot.editMessageText(waitText, { chat_id: chatId, message_id: editMsgId, parse_mode: 'HTML' }).catch(()=>{});
    } else {
        const msg = await bot.sendMessage(chatId, waitText, { parse_mode: 'HTML' });
        msgIdToEdit = msg.message_id;
    }

    try {
        if (!settings || !settings.mauth_api) {
            return bot.editMessageText(`❌ <b>API Key is not configured!</b>`, { chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'HTML' });
        }

        const headers = { 'mauthapi': settings.mauth_api };
        const res = await axios.post(`${API_BASE_URL}/getnum`, { rid: range }, { headers });
        
        if (res.data && res.data.meta && res.data.meta.code !== 200) {
            return bot.editMessageText(`❌ <b>Out of Stock!</b>\nRange <code>${range}</code> currently has no numbers available.`, { chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'HTML' });
        }
        
        const fullNum = res.data.data.full_number;
        await supabase.from('active_numbers').insert([{ telegram_id: chatId, full_number: fullNum, range_prefix: range, status: 'PENDING' }]);
        
        let { data: u } = await supabase.from('bot_users').select('total_numbers').eq('telegram_id', chatId).single();
        await supabase.from('bot_users').update({ total_numbers: (u.total_numbers || 0) + 1 }).eq('telegram_id', chatId);

        const msgText = `🆕 <b>New number allocated!</b>\n\n📱 <b>Number:</b> <code>${fullNum}</code>\n📋 <b>Range:</b> <code>${range}</code>\n⏳ Checking for OTP in real-time...\n\n<i>(Tap the number above to copy it instantly)</i>`;
        
        const kb = { inline_keyboard: [
            [{ text: '🔄 Change Number', callback_data: `req_num_${range}` }],
            [{ text: '📩 Fetch OTP', callback_data: `chk_otp_${fullNum}` }]
        ]};
        return bot.editMessageText(msgText, { chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'HTML', reply_markup: kb });
    } catch(e) {
        return bot.editMessageText(`❌ <b>Network Error! Server is unreachable.</b>`, { chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'HTML' });
    }
}

// ============================================================================
// 4. MAIN MESSAGE PROCESSOR
// ============================================================================
async function processMessage(msg) {
    const chatId = msg.chat.id;
    const text = msg.text || '';
    if (!text) return;

    const user = await getUser(chatId);
    const { data: settings } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
    
    const isSuperAdmin = SUPER_ADMIN_IDS.includes(Number(chatId));
    const isSubAdmin = user.is_admin;
    const isAdmin = isSuperAdmin || isSubAdmin;
    
    const mainMenu = getMainMenu(isSuperAdmin, isSubAdmin);
    const currentAdminMenu = getAdminMenu(isSuperAdmin);

    // ------------------------------------------------------------------------
    // HIDDEN BAN/UNBAN COMMAND (Only for Admins)
    // ------------------------------------------------------------------------
    if (isAdmin && /^\d+ (ban|unban)$/i.test(text.trim())) {
        const parts = text.trim().toLowerCase().split(' ');
        const targetId = Number(parts[0]);
        const isBan = parts[1] === 'ban';
        await supabase.from('bot_users').update({ is_banned: isBan }).eq('telegram_id', targetId);
        return bot.sendMessage(chatId, `✅ <b>Success:</b> User <code>${targetId}</code> has been ${isBan ? 'Banned' : 'Unbanned'}.`, { parse_mode: 'HTML' });
    }

    if (text === '❌ Cancel' || text === '🔙 Back to Main') {
        await updateState(chatId, null);
        return bot.sendMessage(chatId, "🏠 <b>Returned to Main Menu.</b>", { parse_mode: 'HTML', ...mainMenu });
    }

    if (user.is_banned) return bot.sendMessage(chatId, "🚫 <b>You are permanently banned from using this bot.</b>", { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    
    if (settings.maintenance_mode && !isAdmin) {
        return bot.sendMessage(chatId, `🛠️ <b>Bot Under Maintenance!</b>\n\n💬 <i>${settings.maintenance_msg || 'System Update in Progress!'}</i>`, { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    }

    const state = user.current_state;

    // USER STATES
    if (state === 'WAITING_RANGE') {
        const range = text.trim().toUpperCase().replace(/X/g, '');
        if(isNaN(range)) return bot.sendMessage(chatId, "⚠️ <b>Invalid range! Please send numbers only.</b>", { parse_mode: 'HTML' });
        
        await updateState(chatId, null);
        await supabase.from('bot_users').update({ saved_range: range }).eq('telegram_id', chatId);
        return bot.sendMessage(chatId, `✅ <b>Range Successfully Saved!</b>\n\n🎯 <b>Active Range:</b> <code>${range}</code>\n<i>Click 'Get Number' to start working.</i>`, { parse_mode: 'HTML', ...mainMenu });
    }

    if (state === 'WAITING_2FA_SECRET') {
        await updateState(chatId, null);
        try {
            const cleanSecret = text.replace(/\s+/g, '').toUpperCase();
            const token = authenticator.generate(cleanSecret);
            return bot.sendMessage(chatId, `✅ <b>2FA Token Generated!</b>\n━━━━━━━━━━━━━━━━━\n🔑 <b>Secret:</b> <code>${cleanSecret}</code>\n💬 <b>Code:</b> <code>${token}</code>`, { parse_mode: 'HTML', ...mainMenu });
        } catch (e) {
            return bot.sendMessage(chatId, "❌ <b>Invalid Secret Key format.</b>", { parse_mode: 'HTML', ...mainMenu });
        }
    }

    // ADMIN STATES
    if (isAdmin) {
        if (state === 'WAITING_API_KEY' && isSuperAdmin) {
            await supabase.from('bot_settings').update({ mauth_api: text.trim() }).eq('id', 1);
            await updateState(chatId, null);
            return bot.sendMessage(chatId, "✅ <b>API Key Updated Successfully!</b>", { parse_mode: 'HTML', ...currentAdminMenu });
        }
        if (state === 'WAITING_BLACKLIST_RANGE' && isSuperAdmin) {
            const newBlacklist = text.trim().toLowerCase() === 'clear' ? '' : text.trim();
            await supabase.from('bot_settings').update({ blacklisted_ranges: newBlacklist }).eq('id', 1);
            await updateState(chatId, null);
            return bot.sendMessage(chatId, `✅ <b>Blacklist Updated!</b>`, { parse_mode: 'HTML', ...currentAdminMenu });
        }
        if (state === 'WAITING_SUB_ADMIN' && isSuperAdmin) {
            const parts = text.split(' ');
            if(!parts[0] || (parts[1] !== 'add' && parts[1] !== 'remove')) return bot.sendMessage(chatId, "⚠️ Format: <code>ID add</code> OR <code>ID remove</code>", { parse_mode: 'HTML' });
            
            const targetId = Number(parts[0]);
            const isAdding = parts[1] === 'add';
            await supabase.from('bot_users').update({ is_admin: isAdding }).eq('telegram_id', targetId);
            await updateState(chatId, null);
            
            bot.sendMessage(chatId, `✅ <b>Sub-Admin list updated.</b>`, { parse_mode: 'HTML', ...currentAdminMenu });
            
            if (isAdding) {
                bot.sendMessage(targetId, `🎉 <b>Congratulations!</b>\nYou have been promoted to <b>Sub-Admin</b> of this bot.\n\nPlease click /start to load your new Admin Panel.`, { parse_mode: 'HTML' }).catch(()=>{});
            }
            return;
        }
        if (state === 'WAITING_USER_INFO') {
            const tId = Number(text.trim());
            const { data: tu } = await supabase.from('bot_users').select('*').eq('telegram_id', tId).single();
            await updateState(chatId, null);
            if(!tu) return bot.sendMessage(chatId, "❌ <b>User not found in DB.</b>", { parse_mode: 'HTML', ...currentAdminMenu });
            
            const uInfo = `🔍 <b>User Information</b>\n━━━━━━━━━━━━━━━━━\n🆔 <b>ID:</b> <code>${tu.telegram_id}</code>\n📞 <b>Numbers Taken:</b> ${tu.total_numbers}\n📩 <b>OTPs Decoded:</b> ${tu.total_otps}\n💾 <b>Saved Range:</b> ${tu.saved_range || 'None'}\n🚫 <b>Banned:</b> ${tu.is_banned ? 'Yes' : 'No'}\n👑 <b>Admin:</b> ${tu.is_admin ? 'Yes (Sub)' : 'No'}`;
            return bot.sendMessage(chatId, uInfo, { parse_mode: 'HTML', ...currentAdminMenu });
        }
        if (state === 'WAITING_MAINTENANCE_MSG' && isSuperAdmin) {
            await supabase.from('bot_settings').update({ maintenance_mode: true, maintenance_msg: text }).eq('id', 1);
            await updateState(chatId, null);
            return bot.sendMessage(chatId, `🔴 <b>Maintenance Mode is now ON!</b>\nReason saved successfully.`, { parse_mode: 'HTML', ...currentAdminMenu });
        }
        if (state === 'WAITING_BROADCAST') {
            await updateState(chatId, `CONFIRM_BCAST:${text}`);
            return bot.sendMessage(chatId, `📢 <b>Broadcast Preview:</b>\n\n${text}\n\n<i>Send this to all users?</i>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✅ Send Now', callback_data: 'run_bcast' }, { text: '❌ Cancel', callback_data: 'close' }]] } });
        }
    }

    // ------------------------------------------------------------------------
    // MAIN MENU COMMANDS
    // ------------------------------------------------------------------------
    if (text.startsWith('/start')) {
        return bot.sendMessage(chatId, `👋 <b>Welcome to the Premium SMS Bot!</b>\n\n🤖 I am your advanced assistant for getting verification codes (OTP) quickly and securely.`, { parse_mode: 'HTML', ...mainMenu });
    }
    
    if (text === '⚙️ Set Range') {
        const current = user.saved_range ? `<code>${user.saved_range}</code> (Active ✅)` : `<b>None</b> ❌`;
        await updateState(chatId, 'WAITING_RANGE');
        return bot.sendMessage(chatId, `⚙️ <b>Range Configuration</b>\n━━━━━━━━━━━━━━━━━\n📌 <b>Current Range:</b> ${current}\n\n🔢 Please type the new Range ID you want to set:`, { parse_mode: 'HTML', ...cancelMenu });
    }

    if (text === '🚀 Get Number') {
        if (!user.saved_range) {
            await updateState(chatId, 'WAITING_RANGE');
            return bot.sendMessage(chatId, "⚙️ <b>You haven't set a range yet!</b>\nPlease type the Range ID you want to use:", { parse_mode: 'HTML', ...cancelMenu });
        }
        return fetchNumberAction(chatId, user.saved_range, settings, null);
    }

    if (text === '🔐 2FA') {
        await updateState(chatId, 'WAITING_2FA_SECRET');
        return bot.sendMessage(chatId, "🔐 <b>2FA Authenticator</b>\n━━━━━━━━━━━━━━━━━\nSend your Secret Key to generate a token:", { parse_mode: 'HTML', ...cancelMenu });
    }

    if (text === '🚦 Traffic') {
        const statusMsg = await bot.sendMessage(chatId, `⏳ <b>Analyzing Live Traffic...</b>`, { parse_mode: 'HTML' });
        try {
            const headers = { 'mauthapi': settings.mauth_api };
            const [accessRes, consoleRes] = await Promise.all([ axios.get(`${API_BASE_URL}/liveaccess`, { headers }), axios.get(`${API_BASE_URL}/console`, { headers }) ]);
            
            const hitCounts = {};
            if (consoleRes.data.data && consoleRes.data.data.hits) {
                consoleRes.data.data.hits.forEach(h => hitCounts[h.range] = (hitCounts[h.range] || 0) + 1);
            }

            const targetServices = ['fb', 'facebook', 'wa', 'whatsapp', 'tg', 'telegram'];
            const activeServices = accessRes.data.data.services.filter(s => 
                targetServices.some(ts => s.sid.toLowerCase().includes(ts)) && s.ranges && s.ranges.length > 0
            );

            let trafficMsg = `🚦 <b>Live Network Traffic</b>\n━━━━━━━━━━━━━━━━━\n`;
            if (activeServices.length === 0) {
                trafficMsg += `❌ <b>No traffic currently available for FB, WhatsApp, or Telegram.</b>`; 
            } else {
                activeServices.forEach(srv => {
                    let sName = srv.sid.toUpperCase();
                    if(sName.includes('FB')) sName = 'Facebook (FB)';
                    else if(sName.includes('WA')) sName = 'WhatsApp (WA)';
                    else if(sName.includes('TG')) sName = 'Telegram (TG)';
                    
                    trafficMsg += `🔷 <b>${sName}</b>\n`;
                    srv.ranges.slice(0, 6).forEach(r => {
                        const hits = hitCounts[r] || 0;
                        let s = hits >= 4 ? '🟢 High' : (hits >= 2 ? '🟡 Med' : '🔴 Low');
                        trafficMsg += `  🔸 <code>${r}</code> (${s})\n`;
                    });
                    trafficMsg += '\n';
                });
            }
            return bot.editMessageText(trafficMsg, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔄 Refresh Data', callback_data: 'live_traffic' }], [{ text: '🛑 Close', callback_data: 'close' }]] } });
        } catch(e) {
            return bot.editMessageText(`❌ <b>Failed to fetch live stats.</b>`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' });
        }
    }

    if (text === '🎧 Support') {
        const supMsg = `👨‍💻 <b>Support Center</b>\n━━━━━━━━━━━━━━━━━\nFor any technical assistance, API issues, or inquiries, please contact:\n👉 <b>@SiyamExclusive</b>`;
        return bot.sendMessage(chatId, supMsg, { parse_mode: 'HTML' });
    }

    // 👑 ADMIN COMMANDS
    if (isAdmin) {
        if (text === '👑 Admin Panel') return bot.sendMessage(chatId, "🔐 <b>Admin Control Center Authorized.</b>", { parse_mode: 'HTML', ...currentAdminMenu });
        
        if (text === '📡 API Management' && isSuperAdmin) {
            const statusMsg = await bot.sendMessage(chatId, `⏳ <b>Checking API connection...</b>`, { parse_mode: 'HTML' });
            let bal = "N/A", otps = "N/A", status = "🔴 OFFLINE / INVALID";
            try {
                const headers = { 'mauthapi': settings.mauth_api };
                const res = await axios.get(`${API_BASE_URL}/console`, { headers });
                if(res.data && res.data.meta && res.data.meta.code === 200) {
                    status = "🟢 ACTIVE";
                    // Attempting to extract stats if API returns them
                    if (res.data.data) {
                        bal = res.data.data.balance !== undefined ? `$${res.data.data.balance}` : "Hidden";
                    }
                }
            } catch(e) {}
            
            const api = settings.mauth_api || "";
            const maskedApi = api.length > 8 ? `${api.substring(0, 4)}${'*'.repeat(12)}${api.substring(api.length - 4)}` : 'Not Set';
            
            const msg = `📡 <b>API Control Center</b>\n━━━━━━━━━━━━━━━━━\n⚡ <b>Status:</b> ${status}\n🔑 <b>API Key:</b> <code>${maskedApi}</code>\n💰 <b>Balance:</b> ${bal}`;
            const kb = { inline_keyboard: [[{ text: '⚙️ Set New API Key', callback_data: 'set_api_btn' }]] };
            return bot.editMessageText(msg, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML', reply_markup: kb });
        }

        if (text === '⛔ Range Blacklist' && isSuperAdmin) {
            await updateState(chatId, 'WAITING_BLACKLIST_RANGE');
            return bot.sendMessage(chatId, `⛔ <b>Range Blacklist</b>\nSend the ranges to block (comma separated) or type <code>clear</code> to empty:`, { parse_mode: 'HTML', ...cancelMenu });
        }
        if (text === '🛡️ Sub-Admin' && isSuperAdmin) {
            await updateState(chatId, 'WAITING_SUB_ADMIN');
            return bot.sendMessage(chatId, "🛡️ <b>Manage Sub-Admins</b>\n━━━━━━━━━━━━━━━━━\nSend format: <code>TelegramID add</code> OR <code>TelegramID remove</code>", { parse_mode: 'HTML', ...cancelMenu });
        }
        if (text === '🔍 User Info') {
            await updateState(chatId, 'WAITING_USER_INFO');
            return bot.sendMessage(chatId, "🔍 <b>Search User</b>\nSend the Telegram ID to get their details:", { parse_mode: 'HTML', ...cancelMenu });
        }
        if (text === '📢 Broadcast') {
            await updateState(chatId, 'WAITING_BROADCAST');
            return bot.sendMessage(chatId, "📢 <b>Send broadcast message (HTML allowed):</b>", { parse_mode: 'HTML', ...cancelMenu });
        }
        if (text === '🔴 Maintenance' && isSuperAdmin) {
            if (settings.maintenance_mode) {
                await supabase.from('bot_settings').update({ maintenance_mode: false }).eq('id', 1);
                return bot.sendMessage(chatId, `🟢 <b>Maintenance Mode is now OFF!</b>\nUsers can use the bot normally.`, { parse_mode: 'HTML' });
            } else {
                await updateState(chatId, 'WAITING_MAINTENANCE_MSG');
                return bot.sendMessage(chatId, `🔴 <b>Turn ON Maintenance</b>\nPlease type the reason/message that users will see:`, { parse_mode: 'HTML', ...cancelMenu });
            }
        }
        if (text === '📈 Global Stats') {
            const { data: users } = await supabase.from('bot_users').select('total_otps, total_numbers');
            let tOtp = 0, tNum = 0;
            if (users) {
                users.forEach(u => { 
                    tOtp += (u.total_otps || 0); 
                    tNum += (u.total_numbers || 0); 
                });
            }

            const { data: activeDB } = await supabase.from('active_numbers').select('range_prefix').eq('status', 'COMPLETED');
            const rangeCounts = {};
            if (activeDB) {
                activeDB.forEach(a => { rangeCounts[a.range_prefix] = (rangeCounts[a.range_prefix] || 0) + 1; });
            }
            
            let statMsg = `📊 <b>Global System Stats</b>\n━━━━━━━━━━━━━━━━━\n👥 <b>Total Users:</b> ${users ? users.length : 0}\n📞 <b>Total Numbers:</b> ${tNum}\n📩 <b>Total OTPs:</b> ${tOtp}\n\n🔥 <b>Top Successful Ranges:</b>\n`;
            
            Object.entries(rangeCounts)
                .sort((a,b) => b[1] - a[1])
                .slice(0, 7)
                .forEach(([r, c]) => { statMsg += `  ⮑ <code>${r}</code>: ${c} OTPs\n`; });

            return bot.sendMessage(chatId, statMsg, { parse_mode: 'HTML' });
        }
    }
}

// ============================================================================
// 5. CALLBACK PROCESSOR (Inline Buttons)
// ============================================================================
async function processCallback(query) {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const data = query.data;
    
    if(data === 'close') return bot.deleteMessage(chatId, msgId).catch(()=>{});

    if (data === 'live_traffic') {
        await bot.editMessageText(`⏳ <b>Refreshing Live Traffic...</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
        await processMessage({ chat: { id: chatId }, text: '🚦 Traffic' });
        return bot.deleteMessage(chatId, msgId).catch(()=>{});
    }

    if (data === 'set_api_btn') {
        await updateState(chatId, 'WAITING_API_KEY');
        return bot.sendMessage(chatId, `🌐 <b>API Configuration</b>\n🔑 Provide the new Master mauthapi Key:`, { parse_mode: 'HTML', ...cancelMenu });
    }

    // 🚀 SEAMLESS NUMBER CHANGE (Edits the SAME message ID)
    if (data.startsWith('req_num_')) {
        const range = data.replace('req_num_', '');
        const { data: settings } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
        return fetchNumberAction(chatId, range, settings, msgId);
    }

    // 🚀 OTP MATCHER & PERFECT FORMATTING
    if (data.startsWith('chk_otp_')) {
        const num = data.replace('chk_otp_', '');
        const cleanNum = num.replace('+', '').trim();
        
        try {
            const { data: settings } = await supabase.from('bot_settings').select('mauth_api').eq('id', 1).single();
            const headers = { 'mauthapi': settings.mauth_api };

            const res = await axios.get(`${API_BASE_URL}/success-otp`, { headers });
            let otpFound = null;
            if(res.data && res.data.data && res.data.data.otps) {
                otpFound = res.data.data.otps.find(o => o.number && o.number.includes(cleanNum));
            }

            if (otpFound) {
                let { data: u } = await supabase.from('bot_users').select('total_otps, saved_range').eq('telegram_id', chatId).single();
                await supabase.from('bot_users').update({ total_otps: (u.total_otps || 0) + 1 }).eq('telegram_id', chatId);
                await supabase.from('active_numbers').update({ status: 'COMPLETED' }).eq('telegram_id', chatId).eq('full_number', num);

                const cleanCode = extractOTP(otpFound.message || "");

                // PERFECT DESIGN FORMAT: Line breaks between Number and Code
                const smsg = `✅ <b>OTP Received Successfully!</b>\n━━━━━━━━━━━━━━━━━━━━\n📱 <b>Number:</b> <code>${num}</code>\n\n🔑 <b>Verification Code:</b> <code>${cleanCode}</code>`;
                
                // Edit Current Box
                await bot.editMessageText(smsg, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }).catch(()=>{});

                // Auto-Fetch Next Number Below (Lightning Fast Workflow)
                let { data: act } = await supabase.from('active_numbers').select('range_prefix').eq('full_number', num).single();
                let rangeToFetch = act ? act.range_prefix : u.saved_range;
                
                if(rangeToFetch) {
                    await fetchNumberAction(chatId, rangeToFetch, settings, null);
                }
                return;
            } else {
                return bot.answerCallbackQuery(query.id, { text: `⏳ OTP not received yet. Keep checking!`, show_alert: false });
            }
        } catch(e) {
            return bot.answerCallbackQuery(query.id, { text: `❌ API Error while checking OTP.`, show_alert: true });
        }
    }

    if (data === 'run_bcast') {
        let { data: userState } = await supabase.from('bot_users').select('current_state').eq('telegram_id', chatId).single();
        if (userState && userState.current_state && userState.current_state.startsWith('CONFIRM_BCAST:')) {
            const bMsg = userState.current_state.replace('CONFIRM_BCAST:', '');
            await updateState(chatId, null);
            await bot.editMessageText(`⏳ <b>Broadcasting...</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
            
            const { data: users } = await supabase.from('bot_users').select('telegram_id');
            let s = 0, f = 0;
            for (const u of users) {
                try { await bot.sendMessage(u.telegram_id, bMsg, { parse_mode: 'HTML' }); s++; } 
                catch(e){ f++; }
                await new Promise(res => setTimeout(res, 40)); 
            }
            return bot.editMessageText(`📢 <b>Broadcast Completed!</b>\n✅ Delivered: ${s}\n❌ Failed: ${f}`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
        }
    }
}

// ============================================================================
// 6. SERVERLESS HTTP HANDLER
// ============================================================================
module.exports = async (req, res) => {
    if (req.method === 'POST') {
        try {
            const update = req.body;
            if (update.message) await processMessage(update.message);
            else if (update.callback_query) await processCallback(update.callback_query);
        } catch (error) { 
            console.error("System Error:", error.message); 
        }
    }
    res.status(200).send('OK');
};
