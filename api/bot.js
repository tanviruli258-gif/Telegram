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
// 2. PROFESSIONAL MENUS & UI (MATCHING SCREENSHOTS)
// ============================================================================
const getMainMenu = (isAdmin) => {
    const kb = [
        ['🚀 Get Number', '⚙️ Set Range'],
        ['🚦 Traffic', '🔐 2FA'],
        ['📊 My Stats', '🎧 Support']
    ];
    if (isAdmin) kb.push(['👑 Admin Panel']);
    return { reply_markup: { keyboard: kb, resize_keyboard: true } };
};

const adminMenu = { 
    reply_markup: { 
        keyboard: [
            ['🌐 API Setup', '📢 Broadcast'], 
            ['💳 Manage Credits', '🚫 Ban / Unban'],
            ['📈 Global Stats', '🔙 Back to Main']
        ], 
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
        user = { telegram_id: chatId, credits: 50, saved_range: null, current_state: null, total_numbers: 0, total_otps: 0 };
        await supabase.from('bot_users').insert([user]);
    }
    return user;
}

async function updateState(chatId, state) {
    await supabase.from('bot_users').update({ current_state: state }).eq('telegram_id', chatId);
}

// Extract OTP Code from full message
function extractOTP(message) {
    const match = message.match(/\b\d{4,8}\b/);
    return match ? match[0] : message;
}

// 🚀 CORE NUMBER FETCHER (With Beautiful UI)
async function fetchNumberAction(chatId, range, settings) {
    const msg = await bot.sendMessage(chatId, `⏳ <b>Allocating new number from <code>${range}</code>...</b>`, { parse_mode: 'HTML' });
    try {
        if (!settings || !settings.mauth_api) {
            return bot.editMessageText(`❌ <b>API Key is not configured! Contact Admin.</b>`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML' });
        }

        const headers = { 'mauthapi': settings.mauth_api };
        const res = await axios.post(`${API_BASE_URL}/getnum`, { rid: range }, { headers });
        
        if (res.data && res.data.meta && res.data.meta.code !== 200) {
            return bot.editMessageText(`❌ <b>Out of Stock!</b>\nRange <code>${range}</code> currently has no numbers available.`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML' });
        }
        
        const fullNum = res.data.data.full_number;
        await supabase.from('active_numbers').insert([{ telegram_id: chatId, full_number: fullNum, range_prefix: range }]);
        
        let { data: u } = await supabase.from('bot_users').select('total_numbers').eq('telegram_id', chatId).single();
        await supabase.from('bot_users').update({ total_numbers: (u.total_numbers || 0) + 1 }).eq('telegram_id', chatId);

        // Beautiful Output Matching the Screenshot
        const msgText = `🆕 <b>New number allocated!</b>\n\n📱 Number: <code>${fullNum}</code>\n📋 Range: <code>${range}</code>\n⏳ Checking for OTP in real-time...\n\n<i>(Tap the number above to copy it instantly)</i>`;
        
        const kb = { inline_keyboard: [
            [{ text: '📄 Copy Number', callback_data: `copy_num_${fullNum}` }], 
            [{ text: '📩 Fetch OTP', callback_data: `chk_otp_${fullNum}` }],
            [{ text: '🔄 Change Number', callback_data: `req_num_${range}` }]
        ]};
        return bot.editMessageText(msgText, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML', reply_markup: kb });
    } catch(e) {
        return bot.editMessageText(`❌ <b>Network Error! Server is unreachable.</b>`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'HTML' });
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

    if (user.is_banned) return bot.sendMessage(chatId, "🚫 <b>You are banned from using this bot.</b>", { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });

    // ------------------------------------------------------------------------
    // STATE ENGINE (Handling Inputs)
    // ------------------------------------------------------------------------
    const state = user.current_state;

    // SET RANGE
    if (state === 'WAITING_RANGE') {
        const range = text.trim().toUpperCase().replace(/X/g, '');
        if(isNaN(range)) return bot.sendMessage(chatId, "⚠️ <b>Invalid range! Please send numbers only.</b>", { parse_mode: 'HTML' });
        
        await updateState(chatId, null);
        await supabase.from('bot_users').update({ saved_range: range }).eq('telegram_id', chatId);
        return bot.sendMessage(chatId, `✅ <b>Range Successfully Saved!</b>\n\nYour active range is now: <code>${range}</code>\n<i>Click 'Get Number' to start working.</i>`, { parse_mode: 'HTML', ...mainMenu });
    }

    // 2FA GENERATOR
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
        if (state === 'WAITING_API_KEY') {
            await supabase.from('bot_settings').update({ mauth_api: text.trim() }).eq('id', 1);
            await updateState(chatId, null);
            return bot.sendMessage(chatId, "✅ <b>API Key Updated Successfully!</b>", { parse_mode: 'HTML', ...adminMenu });
        }
        if (state === 'WAITING_MANAGE_CREDIT') {
            const parts = text.split(' ');
            if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) {
                return bot.sendMessage(chatId, "⚠️ Send as: <code>TelegramID Amount</code>", { parse_mode: 'HTML' });
            }
            const targetId = Number(parts[0]);
            const amount = Number(parts[1]);
            
            let { data: targetUser } = await supabase.from('bot_users').select('credits').eq('telegram_id', targetId).single();
            if (!targetUser) return bot.sendMessage(chatId, "❌ User not found.", { parse_mode: 'HTML' });
            
            const newBal = (targetUser.credits || 0) + amount;
            await supabase.from('bot_users').update({ credits: newBal }).eq('telegram_id', targetId);
            await updateState(chatId, null);
            bot.sendMessage(targetId, `💰 <b>Admin updated your balance!</b>\nNew balance: <b>${newBal} Credits</b>`, { parse_mode: 'HTML' }).catch(()=>{});
            return bot.sendMessage(chatId, `✅ <b>Success!</b>\nNew Balance: ${newBal}`, { parse_mode: 'HTML', ...adminMenu });
        }
        if (state === 'WAITING_BROADCAST') {
            await updateState(chatId, `CONFIRM_BCAST:${text}`);
            return bot.sendMessage(chatId, `📢 <b>Broadcast Preview:</b>\n\n${text}\n\n<i>Send this to all users?</i>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✅ Send Now', callback_data: 'run_bcast' }, { text: '❌ Cancel', callback_data: 'close' }]] } });
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
    if (text.startsWith('/start')) {
        const wlcMsg = `👋 <b>Welcome to the Premium SMS Bot!</b>\n\n🤖 I am your advanced assistant for getting verification codes (OTP) quickly and securely.\n\nPlease use the beautiful menu below to navigate:`;
        return bot.sendMessage(chatId, wlcMsg, { parse_mode: 'HTML', ...mainMenu });
    }
    
    if (text === '⚙️ Set Range') {
        await updateState(chatId, 'WAITING_RANGE');
        return bot.sendMessage(chatId, "🔢 <b>Enter the Range ID</b>\n\nPlease type the Range ID you want to get a number from (e.g. <code>26134</code> or <code>22501XXX</code>):", { parse_mode: 'HTML', ...cancelMenu });
    }

    if (text === '🚀 Get Number') {
        if (!user.saved_range) {
            await updateState(chatId, 'WAITING_RANGE');
            return bot.sendMessage(chatId, "⚙️ <b>You haven't set a range yet!</b>\nPlease type the Range ID you want to use (e.g. 26134):", { parse_mode: 'HTML', ...cancelMenu });
        }
        
        if (user.credits <= 0) {
            return bot.sendMessage(chatId, "❌ <b>Insufficient Credits! Contact Admin.</b>", { parse_mode: 'HTML' });
        }

        const { data: settings } = await supabase.from('bot_settings').select('mauth_api').eq('id', 1).single();
        return fetchNumberAction(chatId, user.saved_range, settings);
    }

    if (text === '🔐 2FA') {
        await updateState(chatId, 'WAITING_2FA_SECRET');
        return bot.sendMessage(chatId, "🔐 <b>2FA Authenticator</b>\n━━━━━━━━━━━━━━━━━\nSend your Secret Key to generate a token:", { parse_mode: 'HTML', ...cancelMenu });
    }

    if (text === '🚦 Traffic') {
        const statusMsg = await bot.sendMessage(chatId, `⏳ <b>Analyzing Live Traffic...</b>`, { parse_mode: 'HTML' });
        try {
            const { data: settings } = await supabase.from('bot_settings').select('mauth_api').eq('id', 1).single();
            const headers = { 'mauthapi': settings.mauth_api };
            const [accessRes, consoleRes] = await Promise.all([ axios.get(`${API_BASE_URL}/liveaccess`, { headers }), axios.get(`${API_BASE_URL}/console`, { headers }) ]);
            
            const hitCounts = {};
            if (consoleRes.data.data && consoleRes.data.data.hits) {
                consoleRes.data.data.hits.forEach(h => hitCounts[h.range] = (hitCounts[h.range] || 0) + 1);
            }

            const activeServices = accessRes.data.data.services.filter(s => s.ranges && s.ranges.length > 0);
            let trafficMsg = `🚦 <b>Live Network Traffic</b>\n━━━━━━━━━━━━━━━━━\n`;
            
            if (activeServices.length === 0) trafficMsg += `❌ No active traffic right now.`; 
            else {
                activeServices.slice(0, 5).forEach(srv => {
                    trafficMsg += `🔷 <b>${srv.sid.toUpperCase()}</b>\n`;
                    srv.ranges.slice(0, 4).forEach(r => {
                        const hits = hitCounts[r] || 0;
                        let s = hits >= 4 ? '🟢 High' : (hits >= 2 ? '🟡 Med' : '🔴 Low');
                        trafficMsg += `  ⮑ <code>${r}</code> (${s})\n`;
                    });
                    trafficMsg += '\n';
                });
            }
            return bot.editMessageText(trafficMsg, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔄 Refresh Data', callback_data: 'live_traffic' }], [{ text: '🛑 Close', callback_data: 'close' }]] } });
        } catch(e) {
            return bot.editMessageText(`❌ <b>Failed to fetch live stats.</b>`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' });
        }
    }

    if (text === '📊 My Stats') {
        const profMsg = `👤 <b>Your Account Statistics</b>\n━━━━━━━━━━━━━━━━━\n🆔 <b>ID:</b> <code>${chatId}</code>\n💰 <b>Balance:</b> ${user.credits} Credits\n📞 <b>Numbers Taken:</b> ${user.total_numbers}\n📩 <b>OTPs Decoded:</b> ${user.total_otps}\n💾 <b>Active Range:</b> ${user.saved_range || 'Not Set'}`;
        return bot.sendMessage(chatId, profMsg, { parse_mode: 'HTML' });
    }

    if (text === '🎧 Support') {
        return bot.sendMessage(chatId, `👨‍💻 <b>Support Center</b>\n\nIf you need any help, credits, or custom API access, please contact the Administrator.`, { parse_mode: 'HTML' });
    }

    // ADMIN PANEL
    if (isAdmin) {
        if (text === '👑 Admin Panel') return bot.sendMessage(chatId, "🔐 <b>Admin Control Center Authorized.</b>", { parse_mode: 'HTML', ...adminMenu });
        if (text === '🌐 API Setup') {
            await updateState(chatId, 'WAITING_API_KEY');
            return bot.sendMessage(chatId, "🔑 <b>Provide the Master mauthapi Key:</b>", { parse_mode: 'HTML', ...cancelMenu });
        }
        if (text === '💳 Manage Credits') {
            await updateState(chatId, 'WAITING_MANAGE_CREDIT');
            return bot.sendMessage(chatId, "💳 <b>Send format:</b> <code>TelegramID Amount</code>\nExample: <code>123456789 10</code>", { parse_mode: 'HTML', ...cancelMenu });
        }
        if (text === '📢 Broadcast') {
            await updateState(chatId, 'WAITING_BROADCAST');
            return bot.sendMessage(chatId, "📢 <b>Send broadcast message (HTML allowed):</b>", { parse_mode: 'HTML', ...cancelMenu });
        }
        if (text === '🚫 Ban / Unban') {
            await updateState(chatId, 'WAITING_BAN_USER');
            return bot.sendMessage(chatId, "🚫 <b>Send Telegram ID to Ban:</b>", { parse_mode: 'HTML', ...cancelMenu });
        }
        if (text === '📈 Global Stats') {
            const { data: users } = await supabase.from('bot_users').select('total_otps, total_numbers, credits');
            let tOtp = 0, tNum = 0, tCred = 0;
            users.forEach(u => { tOtp += u.total_otps; tNum += u.total_numbers; tCred += u.credits; });
            return bot.sendMessage(chatId, `📊 <b>Global System Stats</b>\n━━━━━━━━━━━━━━━━━\n👥 <b>Total Users:</b> ${users.length}\n📞 <b>Total Numbers:</b> ${tNum}\n📩 <b>Total OTPs:</b> ${tOtp}\n💰 <b>Total Floating Credits:</b> ${tCred}`, { parse_mode: 'HTML' });
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

    if (data.startsWith('copy_num_')) {
        const numToCopy = data.replace('copy_num_', '');
        return bot.answerCallbackQuery(query.id, { text: `📱 Number: ${numToCopy}\n\nTip: You can tap the number in the message above to copy it instantly!`, show_alert: true });
    }

    if (data.startsWith('req_num_')) {
        const range = data.replace('req_num_', '');
        const { data: settings } = await supabase.from('bot_settings').select('mauth_api').eq('id', 1).single();
        return fetchNumberAction(chatId, range, settings);
    }

    // 🚀 OTP MATCHER & FORMATTER
    if (data.startsWith('chk_otp_')) {
        const num = data.replace('chk_otp_', '');
        const cleanNum = num.replace('+', '').trim();
        
        const pMsg = await bot.sendMessage(chatId, `⏳ <b>Fetching OTP...</b>`, { parse_mode: 'HTML' });
        
        try {
            const { data: settings } = await supabase.from('bot_settings').select('mauth_api').eq('id', 1).single();
            const headers = { 'mauthapi': settings.mauth_api };

            const res = await axios.get(`${API_BASE_URL}/success-otp`, { headers });
            let otpFound = null;
            if(res.data && res.data.data && res.data.data.otps) {
                otpFound = res.data.data.otps.find(o => o.number && o.number.includes(cleanNum));
            }
            
            await bot.deleteMessage(chatId, pMsg.message_id).catch(()=>{});

            if (otpFound) {
                // Deduct Credit & Update Stats
                let { data: u } = await supabase.from('bot_users').select('total_otps, credits').eq('telegram_id', chatId).single();
                await supabase.from('bot_users').update({ total_otps: (u.total_otps || 0) + 1, credits: Math.max(0, u.credits - 1) }).eq('telegram_id', chatId);
                await supabase.from('active_numbers').update({ status: 'COMPLETED' }).eq('telegram_id', chatId).eq('full_number', num);

                // Smart Extraction of the Code
                const rawMessage = otpFound.message || "";
                const cleanCode = extractOTP(rawMessage);

                // Re-format the entire message box beautifully
                const smsg = `✅ **OTP Received Successfully!**\n\n📱 **Number:** <code>${num}</code>\n💬 **Full Message:** ${rawMessage}\n\n🔑 **Verification Code:**\n<code>${cleanCode}</code>`;
                
                return bot.editMessageText(smsg, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
            } else {
                return bot.answerCallbackQuery(query.id, { text: `⏳ OTP not received yet. Keep checking!`, show_alert: false });
            }
        } catch(e) {
            await bot.deleteMessage(chatId, pMsg.message_id).catch(()=>{});
            return bot.answerCallbackQuery(query.id, { text: `❌ API Error while checking OTP.`, show_alert: true });
        }
    }

    // Broadcast Engine
    if (data === 'run_bcast' && ADMIN_IDS.includes(Number(chatId))) {
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
