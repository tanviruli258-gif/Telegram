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
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number) : []; 
const API_BASE_URL = 'https://api.2oo9.cloud/MXS47FLFX0U/tness/@public/api';

const bot = new TelegramBot(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// ============================================================================
// 2. PROFESSIONAL MENUS & UI
// ============================================================================
const getMainMenu = (isAdmin) => {
    const kb = [
        ['🔢 Get Number', '📱 Active Sessions'],
        ['🔍 FB UID Checker', '🔐 2FA Generator'],
        ['🚦 Live Traffic', '📊 My Profile']
    ];
    if (isAdmin) kb.push(['⚙️ Admin Panel']);
    return { reply_markup: { keyboard: kb, resize_keyboard: true } };
};

const adminMenu = { 
    reply_markup: { 
        keyboard: [['🌐 API Setup', '📈 Global Stats'], ['🚫 Ban/Unban User', '🔙 Back to Main']], 
        resize_keyboard: true 
    } 
};

const cancelMenu = { reply_markup: { keyboard: [['❌ Cancel']], resize_keyboard: true } };

// ============================================================================
// 3. CORE HELPER FUNCTIONS
// ============================================================================
async function getUser(chatId) {
    let { data: user } = await supabase.from('bot_users').select('*').eq('telegram_id', chatId).single();
    if (!user) {
        user = { telegram_id: chatId, saved_range: null, current_state: null, total_numbers: 0, total_otps: 0 };
        await supabase.from('bot_users').insert([user]);
    }
    return user;
}

async function updateState(chatId, state) {
    await supabase.from('bot_users').update({ current_state: state }).eq('telegram_id', chatId);
}

// 🚀 AUTO FETCH NUMBER LOGIC (Called immediately after setting range)
async function fetchNumberAction(chatId, range, settings) {
    const msg = await bot.sendMessage(chatId, `⏳ <b>Establishing connection and allocating number from <code>${range}</code>...</b>`, { parse_mode: 'HTML' });
    try {
        if (!settings || !settings.mauth_api) {
            return bot.editMessageText(`❌ <b>API Routing Key is missing. Please setup in Admin Panel.</b>`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML' });
        }

        const headers = { 'mauthapi': settings.mauth_api };
        const res = await axios.post(`${API_BASE_URL}/getnum`, { rid: range }, { headers });
        
        if (res.data && res.data.meta && res.data.meta.code !== 200) {
            return bot.editMessageText(`❌ <b>Inventory Error: Range <code>${range}</code> is out of stock.</b>\nPlease change range or try again.`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML' });
        }
        
        const fullNum = res.data.data.full_number;
        await supabase.from('active_numbers').insert([{ telegram_id: chatId, full_number: fullNum, range_prefix: range }]);
        
        let { data: u } = await supabase.from('bot_users').select('total_numbers').eq('telegram_id', chatId).single();
        await supabase.from('bot_users').update({ total_numbers: (u.total_numbers || 0) + 1 }).eq('telegram_id', chatId);

        const msgText = `🌐 <b>SERVICE ACQUIRED SUCCESSFULLY</b>\n━━━━━━━━━━━━━━━━━\n📞 <b>Number:</b> <code>${fullNum}</code>\n📡 <b>Range:</b> <code>${range}</code>\n\n<i>Click below to decode OTP instantly.</i>`;
        const kb = { inline_keyboard: [
            [{ text: '📩 Decode OTP (1-Sec)', callback_data: `chk_otp_${fullNum}` }], 
            [{ text: '🚫 Report Bad Number', callback_data: `report_bad_${fullNum}_new` }],
            [{ text: '🛑 Close Terminal', callback_data: 'close' }]
        ]};
        return bot.editMessageText(msgText, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML', reply_markup: kb });
    } catch(e) {
        return bot.editMessageText(`❌ <b>Network Protocol Error! Verification server unreachable.</b>`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML' });
    }
}

// ============================================================================
// 4. MAIN MESSAGE PROCESSOR
// ============================================================================
async function processMessage(msg) {
    const chatId = msg.chat.id;
    const text = msg.text || '';
    const isAdmin = ADMIN_IDS.includes(Number(chatId));

    if (!text) return;

    const user = await getUser(chatId);
    const mainMenu = getMainMenu(isAdmin);

    if (text === '❌ Cancel' || text === '🔙 Back to Main') {
        await updateState(chatId, null);
        return bot.sendMessage(chatId, "🏠 <b>Returned to Main Menu.</b>", { parse_mode: 'HTML', ...mainMenu });
    }

    if (user.is_banned) return bot.sendMessage(chatId, "🚫 <b>You are banned.</b>", { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });

    // ------------------------------------------------------------------------
    // STATE ENGINE (User Inputs)
    // ------------------------------------------------------------------------
    const state = user.current_state;

    // 🚀 NEW FEATURE: Save Range & Auto-Fetch immediately!
    if (state === 'WAITING_RANGE') {
        const range = text.trim().toUpperCase().replace(/X/g, '');
        if(isNaN(range)) return bot.sendMessage(chatId, "⚠️ <b>Invalid format! Please send numbers only.</b>", { parse_mode: 'HTML' });
        
        await updateState(chatId, null);
        await supabase.from('bot_users').update({ saved_range: range }).eq('telegram_id', chatId);
        
        // 1. Send Main Menu back
        await bot.sendMessage(chatId, `✅ <b>Range Saved:</b> <code>${range}</code>`, { parse_mode: 'HTML', ...mainMenu });
        
        // 2. Fetch number automatically without extra clicks
        const { data: settings } = await supabase.from('bot_settings').select('mauth_api').eq('id', 1).single();
        return fetchNumberAction(chatId, range, settings);
    }

    // 2FA GENERATOR ENGINE
    if (state === 'WAITING_2FA_SECRET') {
        await updateState(chatId, null);
        try {
            const cleanSecret = text.replace(/\s+/g, '').toUpperCase();
            const token = authenticator.generate(cleanSecret);
            return bot.sendMessage(chatId, `✅ <b>2FA Token Generated!</b>\n━━━━━━━━━━━━━━━━━\n🔑 <b>Secret:</b> <code>${cleanSecret}</code>\n💬 <b>Code:</b> <code>${token}</code>`, { parse_mode: 'HTML', ...mainMenu });
        } catch (e) {
            return bot.sendMessage(chatId, "❌ <b>Invalid Secret Key format. Please try again.</b>", { parse_mode: 'HTML', ...mainMenu });
        }
    }

    // FB UID CHECKER (BULK)
    if (state === 'WAITING_FB_UID') {
        const uids = text.split(/[\n, ]+/).map(u => u.trim()).filter(u => u);
        if(uids.length === 0) return bot.sendMessage(chatId, "⚠️ <b>No valid UIDs found.</b>", { parse_mode: 'HTML' });
        if(uids.length > 30) return bot.sendMessage(chatId, "⚠️ <b>Max 30 UIDs per request allowed!</b>", { parse_mode: 'HTML' });
        
        const statusMsg = await bot.sendMessage(chatId, `🔍 <b>Analyzing ${uids.length} UIDs...</b>`, { parse_mode: 'HTML' });
        let resultText = `📋 <b>FB UID Audit Report:</b>\n━━━━━━━━━━━━━━━━━\n`;
        let activeCount = 0, badCount = 0;
        
        for(let uid of uids) {
            try {
                const res = await axios.get(`https://graph.facebook.com/${uid}/picture?redirect=false`, { validateStatus: () => true });
                if (res.data && res.data.data && res.data.data.url && !res.data.data.is_silhouette) {
                    resultText += `✅ <code>${uid}</code> - <b>Active</b>\n`;
                    activeCount++;
                } else {
                    resultText += `❌ <code>${uid}</code> - <b>Banned/Not Found</b>\n`;
                    badCount++;
                }
            } catch(e) { resultText += `⚠️ <code>${uid}</code> - <b>Error</b>\n`; }
        }
        resultText += `\n📊 <b>Total:</b> Active: <b>${activeCount}</b> | Bad: <b>${badCount}</b>`;
        return bot.editMessageText(resultText, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' });
    }

    // ADMIN STATES
    if (isAdmin) {
        if (state === 'WAITING_API_KEY') {
            await supabase.from('bot_settings').update({ mauth_api: text.trim() }).eq('id', 1);
            await updateState(chatId, null);
            return bot.sendMessage(chatId, "✅ <b>Master API Key Saved!</b>", { parse_mode: 'HTML', ...adminMenu });
        }
        if (state === 'WAITING_BAN_USER') {
            await supabase.from('bot_users').update({ is_banned: true }).eq('telegram_id', Number(text.trim()));
            await updateState(chatId, null);
            return bot.sendMessage(chatId, `🚫 <b>User Banned.</b>`, { parse_mode: 'HTML', ...adminMenu });
        }
    }

    // ------------------------------------------------------------------------
    // MAIN COMMANDS
    // ------------------------------------------------------------------------
    if (text === '/start') {
        const wlcMsg = `🌟 <b>Welcome to Enterprise Toolkit!</b>\n\n💼 A robust utility for SMS verifications, 2FA generation, and Bulk FB UID Checking.`;
        return bot.sendMessage(chatId, wlcMsg, { parse_mode: 'HTML', ...mainMenu });
    }
    
    if (text === '🔢 Get Number') {
        if (!user.saved_range) {
            await updateState(chatId, 'WAITING_RANGE');
            return bot.sendMessage(chatId, "⚙️ <b>No active range found.</b>\nPlease input your target range prefix (e.g., 26134):", { parse_mode: 'HTML', ...cancelMenu });
        } else {
            const msgText = `📞 <b>Number Generation Terminal</b>\n━━━━━━━━━━━━━━━━━\n💾 <b>Active Range:</b> <code>${user.saved_range}</code>\n\n<i>Click Fetch to get a number instantly.</i>`;
            const kb = { inline_keyboard: [
                [{ text: `🚀 Fetch Number (${user.saved_range})`, callback_data: `req_num_${user.saved_range}` }],
                [{ text: '⚙️ Change Range', callback_data: 'change_range' }]
            ]};
            return bot.sendMessage(chatId, msgText, { parse_mode: 'HTML', reply_markup: kb });
        }
    }

    if (text === '🔐 2FA Generator') {
        await updateState(chatId, 'WAITING_2FA_SECRET');
        return bot.sendMessage(chatId, "🔐 <b>2FA Authenticator Engine</b>\n━━━━━━━━━━━━━━━━━\nSend your Secret Key (e.g., <code>JBSWY3DPEHPK3PXP</code>):", { parse_mode: 'HTML', ...cancelMenu });
    }

    if (text === '🔍 FB UID Checker') {
        await updateState(chatId, 'WAITING_FB_UID');
        return bot.sendMessage(chatId, "🔍 <b>Bulk FB UID Analyzer</b>\n━━━━━━━━━━━━━━━━━\nSend the UIDs you want to verify.\n<i>Tip: You can paste up to 30 UIDs separated by lines.</i>", { parse_mode: 'HTML', ...cancelMenu });
    }

    if (text === '🚦 Live Traffic') {
        const statusMsg = await bot.sendMessage(chatId, `⏳ <b>Analyzing Server Workload...</b>`, { parse_mode: 'HTML' });
        try {
            const { data: settings } = await supabase.from('bot_settings').select('mauth_api').eq('id', 1).single();
            const headers = { 'mauthapi': settings.mauth_api };
            const [accessRes, consoleRes] = await Promise.all([ axios.get(`${API_BASE_URL}/liveaccess`, { headers }), axios.get(`${API_BASE_URL}/console`, { headers }) ]);
            
            const hitCounts = {};
            if (consoleRes.data.data && consoleRes.data.data.hits) {
                consoleRes.data.data.hits.forEach(h => hitCounts[h.range] = (hitCounts[h.range] || 0) + 1);
            }

            const activeServices = accessRes.data.data.services.filter(s => s.ranges && s.ranges.length > 0);
            let trafficMsg = `🚦 <b>Live Network Status</b>\n━━━━━━━━━━━━━━━━━\n`;
            
            if (activeServices.length === 0) trafficMsg += `❌ No active traffic.`; 
            else {
                activeServices.slice(0, 4).forEach(srv => {
                    trafficMsg += `📱 <b>${srv.sid.toUpperCase()}</b>\n`;
                    srv.ranges.slice(0, 4).forEach(r => {
                        const hits = hitCounts[r] || 0;
                        let s = hits >= 4 ? '🟢 High' : (hits >= 2 ? '🟡 Med' : '🔴 Low');
                        trafficMsg += `⮑ <code>${r}</code> (${s})\n`;
                    });
                    trafficMsg += '\n';
                });
            }
            return bot.editMessageText(trafficMsg, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'live_traffic' }], [{ text: '🛑 Close', callback_data: 'close' }]] } });
        } catch(e) {
            return bot.editMessageText(`❌ <b>Failed to fetch live stats.</b>`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' });
        }
    }

    if (text === '📱 Active Sessions') {
        const { data: active } = await supabase.from('active_numbers').select('*').eq('telegram_id', chatId).eq('status', 'PENDING').order('created_at', { ascending: false }).limit(5);
        if (!active || active.length === 0) return bot.sendMessage(chatId, "📭 <b>No pending SMS sessions.</b>", { parse_mode: 'HTML' });
        
        let msg = "📱 <b>Your Live Sessions:</b>\n\n";
        const kb = [];
        active.forEach(n => {
            kb.push([{ text: `📩 Retrieve OTP: ${n.full_number}`, callback_data: `chk_otp_${n.full_number}` }]);
            kb.push([{ text: `🚫 Report Bad Number`, callback_data: `report_bad_${n.full_number}_${n.id}` }]);
        });
        return bot.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    }

    if (text === '📊 My Profile') {
        return bot.sendMessage(chatId, `👤 <b>Executive Dashboard</b>\n━━━━━━━━━━━━━━━━━\n🆔 <b>Account ID:</b> <code>${chatId}</code>\n📞 <b>Numbers Generated:</b> ${user.total_numbers}\n📩 <b>OTPs Decoded:</b> ${user.total_otps}\n💾 <b>Default Range:</b> ${user.saved_range || 'Not Configured'}`, { parse_mode: 'HTML' });
    }

    // ADMIN PANEL
    if (isAdmin) {
        if (text === '⚙️ Admin Panel') return bot.sendMessage(chatId, "🔐 <b>Admin Control Center Authorized.</b>", { parse_mode: 'HTML', ...adminMenu });
        if (text === '🌐 API Setup') {
            await updateState(chatId, 'WAITING_API_KEY');
            return bot.sendMessage(chatId, "🔑 <b>Please provide the Master mauthapi Key:</b>", { parse_mode: 'HTML', ...cancelMenu });
        }
        if (text === '🚫 Ban/Unban User') {
            await updateState(chatId, 'WAITING_BAN_USER');
            return bot.sendMessage(chatId, "🚫 <b>Send Telegram ID to Ban:</b>", { parse_mode: 'HTML', ...cancelMenu });
        }
        if (text === '📈 Global Stats') {
            const { data: users } = await supabase.from('bot_users').select('total_otps, total_numbers');
            let tOtp = 0, tNum = 0;
            users.forEach(u => { tOtp += u.total_otps; tNum += u.total_numbers; });
            return bot.sendMessage(chatId, `📊 <b>Global Enterprise Matrix</b>\n━━━━━━━━━━━━━━━━━\n👥 <b>Total Accounts:</b> ${users.length}\n📞 <b>Total Generations:</b> ${tNum}\n📩 <b>Total Validations (OTP):</b> ${tOtp}`, { parse_mode: 'HTML' });
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

    if (data === 'change_range') {
        await updateState(chatId, 'WAITING_RANGE');
        await bot.deleteMessage(chatId, msgId).catch(()=>{});
        return bot.sendMessage(chatId, "⚙️ <b>Please input the new range prefix (e.g., 26134):</b>", { parse_mode: 'HTML', ...cancelMenu });
    }

    if (data === 'live_traffic') {
        await bot.editMessageText(`⏳ <b>Refreshing Live Traffic...</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
        // Trigger a fresh message processing for live traffic
        await processMessage({ chat: { id: chatId }, text: '🚦 Live Traffic' });
        return bot.deleteMessage(chatId, msgId).catch(()=>{});
    }

    // BUTTON TRIGGER: FETCH NUMBER
    if (data.startsWith('req_num_')) {
        const range = data.replace('req_num_', '');
        const { data: settings } = await supabase.from('bot_settings').select('mauth_api').eq('id', 1).single();
        // Uses the centralized function
        return fetchNumberAction(chatId, range, settings);
    }

    // 🚀 1-SECOND INSTANT OTP DECODER
    if (data.startsWith('chk_otp_')) {
        const num = data.replace('chk_otp_', '');
        const cleanNum = num.replace('+', '').trim();
        
        // Instant visual feedback
        const pMsg = await bot.sendMessage(chatId, `⏳ <b>Intercepting SMS data...</b>`, { parse_mode: 'HTML' });
        
        try {
            const { data: settings } = await supabase.from('bot_settings').select('mauth_api').eq('id', 1).single();
            const headers = { 'mauthapi': settings.mauth_api };

            // Single rapid API hit
            const res = await axios.get(`${API_BASE_URL}/success-otp`, { headers });
            let otpFound = null;
            if(res.data && res.data.data && res.data.data.otps) {
                otpFound = res.data.data.otps.find(o => o.number && o.number.includes(cleanNum));
            }
            
            await bot.deleteMessage(chatId, pMsg.message_id).catch(()=>{});

            if (otpFound) {
                let { data: u } = await supabase.from('bot_users').select('total_otps').eq('telegram_id', chatId).single();
                await supabase.from('bot_users').update({ total_otps: (u.total_otps || 0) + 1 }).eq('telegram_id', chatId);
                await supabase.from('active_numbers').update({ status: 'COMPLETED' }).eq('telegram_id', chatId).eq('full_number', num);

                const smsg = `✅ <b>VALIDATION COMPLETE!</b>\n━━━━━━━━━━━━━━━━━\n📞 <b>Target:</b> <code>${num}</code>\n💬 <b>Code:</b> <code>${otpFound.message}</code>`;
                return bot.editMessageText(smsg, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
            } else {
                return bot.sendMessage(chatId, `⏳ <b>SMS has not arrived yet for <code>${num}</code>.</b>`, { parse_mode: 'HTML' });
            }
        } catch(e) {
            await bot.deleteMessage(chatId, pMsg.message_id).catch(()=>{});
            return bot.sendMessage(chatId, `❌ <b>Decryption Engine Error.</b> Try again.`, { parse_mode: 'HTML' });
        }
    }

    // REPORT BAD NUMBER
    if (data.startsWith('report_bad_')) {
        const parts = data.split('_');
        const num = parts[2];
        const dbId = parts[3];

        if (dbId !== 'new') {
            await supabase.from('active_numbers').update({ status: 'CANCELLED_BAD' }).eq('id', Number(dbId));
        }
        await bot.answerCallbackQuery(query.id, { text: 'Number flagged as invalid.', show_alert: true });
        return bot.editMessageText(`🚫 <b>Session Terminated.</b>\nNumber <code>${num}</code> has been flagged as bad.`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
    }
}

// ============================================================================
// 6. VERCEL SERVERLESS HTTP HANDLER
// ============================================================================
module.exports = async (req, res) => {
    if (req.method === 'POST') {
        try {
            const update = req.body;
            if (update.message) await processMessage(update.message);
            else if (update.callback_query) await processCallback(update.callback_query);
        } catch (error) { 
            console.error("Critical System Error:", error.message); 
        }
    }
    res.status(200).send('OK');
};
