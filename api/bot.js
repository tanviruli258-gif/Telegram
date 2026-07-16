process.env.NTBA_FIX_319 = 1;
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { authenticator } = require('otplib');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number) : []; 
const API_BASE_URL = 'https://api.2oo9.cloud/MXS47FLFX0U/tness/@public/api';

const bot = new TelegramBot(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

const adminMainMenu = { reply_markup: { keyboard: [['📱 My Active Numbers', '🔢 Get Number'], ['🔍 FB UID Checker', '📊 My History'], ['🔐 2FA Generator', '⚙️ Admin Panel']], resize_keyboard: true } };
const userMainMenu = { reply_markup: { keyboard: [['📱 My Active Numbers', '🔢 Get Number'], ['🔍 FB UID Checker', '📊 My History'], ['🔐 2FA Generator', '🎧 Support']], resize_keyboard: true } };
const cancelMenu = { reply_markup: { keyboard: [['❌ Cancel']], resize_keyboard: true } };
const adminMenu = { reply_markup: { keyboard: [['⚙️ Bot Config', '🌐 API Setup'], ['👥 User Manage', '📈 Global Stats'], ['🔙 Back to Main']], resize_keyboard: true } };

async function getSettings() {
    const { data } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
    return data || {};
}

async function setUserState(chatId, state) {
    await supabase.from('bot_users').update({ current_state: state }).eq('telegram_id', chatId);
}

async function logAction(telegram_id, action, details) {
    await supabase.from('transaction_logs').insert([{ telegram_id, action, details }]);
}

const countryCodes = {
    '1': {n: 'USA/CA', f: '🇺🇸'}, '7': {n: 'Russia/KZ', f: '🇷🇺'}, '20': {n: 'Egypt', f: '🇪🇬'}, 
    '27': {n: 'South Africa', f: '🇿🇦'}, '33': {n: 'France', f: '🇫🇷'}, '34': {n: 'Spain', f: '🇪🇸'},
    '44': {n: 'UK', f: '🇬🇧'}, '49': {n: 'Germany', f: '🇩🇪'}, '62': {n: 'Indonesia', f: '🇮🇩'}, 
    '880': {n: 'Bangladesh', f: '🇧🇩'}, '91': {n: 'India', f: '🇮🇳'}, '92': {n: 'Pakistan', f: '🇵🇰'}
};
function getCountryByRange(range) {
    let clean = range.replace(/X/g, '');
    for (let i = 4; i > 0; i--) {
        let prefix = clean.substring(0, i);
        if (countryCodes[prefix]) return { name: countryCodes[prefix].n, flag: countryCodes[prefix].f, code: clean };
    }
    return { name: `Global`, flag: '🌐', code: clean };
}

async function processMessage(msg) {
    const chatId = msg.chat.id;
    const text = msg.text;
    const isAdmin = ADMIN_IDS.includes(Number(chatId));
    if (!text) return;

    const settings = await getSettings();
    const currentMenu = isAdmin ? adminMainMenu : userMainMenu;

    if (!settings.bot_status && !isAdmin) {
        return bot.sendMessage(chatId, "⚠️ <b>System under maintenance.</b>", { parse_mode: 'HTML' });
    }

    let { data: user } = await supabase.from('bot_users').select('*').eq('telegram_id', chatId).single();
    
    if (!user) {
        user = { telegram_id: chatId, is_approved: isAdmin, is_admin: isAdmin, is_banned: false, credits: 10, current_range: null, current_state: null, total_numbers: 0, total_otps: 0 };
        await supabase.from('bot_users').insert([user]);
    }

    if (user.is_banned) return bot.sendMessage(chatId, "❌ <b>Account Suspended.</b>", { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });

    if (text === '❌ Cancel' || text === '🔙 Back to Main') {
        await setUserState(chatId, null);
        return bot.sendMessage(chatId, "🏠 <b>Main Menu</b>", { parse_mode: 'HTML', ...currentMenu });
    }

    if (user.current_state) {
        const state = user.current_state;
        
        if (state === 'WAITING_MANUAL_RANGE') {
            const range = text.trim().toUpperCase().replace(/[^0-9]/g, ''); 
            if (!range) return bot.sendMessage(chatId, "❌ <b>Invalid format. Numbers only.</b>", { parse_mode: 'HTML' });
            
            await supabase.from('bot_users').update({ current_range: range, current_state: null }).eq('telegram_id', chatId);
            user.current_range = range; // Update local state
            
            // Auto-trigger number fetch using the newly saved range
            const processingMsg = await bot.sendMessage(chatId, `⏳ <b>Fetching number from ${range}...</b>`, { parse_mode: 'HTML', ...currentMenu });
            await processCallback({ message: { chat: { id: chatId }, message_id: processingMsg.message_id }, data: `req_num_${range}` });
            return;
        }

        if (state === 'WAITING_FB_UID') {
            // Support Bulk Checking (split by spaces, commas, or newlines)
            const uids = text.split(/[\s,\n]+/).filter(Boolean);
            
            if (uids.length > 20) return bot.sendMessage(chatId, "⚠️ <b>Please send maximum 20 UIDs at a time.</b>", { parse_mode: 'HTML' });
            
            const statusMsg = await bot.sendMessage(chatId, `⏳ <b>Checking ${uids.length} UIDs...</b>\n<i>Please wait...</i>`, { parse_mode: 'HTML' });
            
            let resultText = `🔍 <b>FB UID Check Results:</b>\n━━━━━━━━━━━━━━━━\n`;
            
            for (let uid of uids) {
                try {
                    const res = await axios.get(`https://www.facebook.com/${uid}`, { 
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
                        validateStatus: () => true,
                        timeout: 5000
                    });
                    
                    if (res.status === 404 || res.status === 302) {
                        resultText += `❌ <code>${uid}</code> - <b>Invalid / Banned</b>\n`;
                    } else {
                        resultText += `✅ <code>${uid}</code> - <b>Active 🟢</b>\n`;
                    }
                } catch (err) {
                    resultText += `⚠️ <code>${uid}</code> - <b>Error Checking</b>\n`;
                }
            }
            
            await logAction(chatId, 'Bulk FB Check', `Checked ${uids.length} UIDs`);
            await bot.deleteMessage(chatId, statusMsg.message_id).catch(()=>{});
            
            // Do NOT set state to null, allowing continuous checking
            resultText += `\n<i>Send more UIDs to check, or press Cancel to exit.</i>`;
            return bot.sendMessage(chatId, resultText, { parse_mode: 'HTML', ...cancelMenu });
        }

        if (state === 'WAITING_2FA_SECRET') {
            await setUserState(chatId, null);
            try {
                const code = authenticator.generate(text.replace(/\s+/g, '').toUpperCase());
                return bot.sendMessage(chatId, `🌟 <b>2FA Generator</b>\n🔑 <b>Code:</b> <code>${code}</code>`, { parse_mode: 'HTML', ...currentMenu });
            } catch (err) {
                return bot.sendMessage(chatId, "❌ <b>Invalid Secret Key format.</b>", { parse_mode: 'HTML', ...currentMenu });
            }
        }
    }

    if (text === '/start') return bot.sendMessage(chatId, settings.welcome_msg || 'Welcome to the Bot!', { parse_mode: 'HTML', ...currentMenu });
    
    if (text === '🔢 Get Number') {
        if(!settings.mauth_api) return bot.sendMessage(chatId, "⚠️ API Key not set by Admin.", { parse_mode: 'HTML' });
        
        if (user.current_range) {
            const numMenu = { 
                reply_markup: { 
                    inline_keyboard: [
                        [{ text: `🎯 Fetch from ${user.current_range}`, callback_data: `req_num_${user.current_range}` }], 
                        [{ text: '⚙️ Change Saved Range', callback_data: 'getnum_manual' }],
                        [{ text: '🚦 Live Traffic Workload', callback_data: 'live_traffic' }]
                    ]
                }
            };
            return bot.sendMessage(chatId, `📞 <b>Get Number Panel</b>\n\n📌 <b>Saved Range:</b> <code>${user.current_range}</code>\n<i>Click below to fetch instantly.</i>`, { parse_mode: 'HTML', ...numMenu });
        } else {
            await setUserState(chatId, 'WAITING_MANUAL_RANGE');
            return bot.sendMessage(chatId, "⚙️ <b>Send the Range Prefix</b>\nExample: <code>26134</code>\n\n<i>This will be saved for future use.</i>", { parse_mode: 'HTML', ...cancelMenu });
        }
    }

    if (text === '📱 My Active Numbers') {
        const { data: activeNumbers } = await supabase.from('active_numbers').select('*').eq('telegram_id', chatId).eq('status', 'PENDING').order('created_at', { ascending: false }).limit(5);
        if (!activeNumbers || activeNumbers.length === 0) return bot.sendMessage(chatId, "📭 <b>You don't have any active numbers.</b>", { parse_mode: 'HTML' });
        
        let msg = "📱 <b>Your Active Sessions:</b>\n<i>Select a number below to check OTP.</i>\n\n";
        const buttons = [];
        activeNumbers.forEach(n => {
            msg += `📞 <code>${n.full_number}</code> (${n.range_prefix})\n`;
            buttons.push([{ text: `📩 Check OTP: ${n.full_number}`, callback_data: `chk_otp_${n.full_number}` }]);
            buttons.push([{ text: `🚫 Report Bad & Cancel: ${n.full_number}`, callback_data: `cancel_num_${n.id}` }]);
        });
        return bot.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
    }

    if (text === '🔍 FB UID Checker') {
        await setUserState(chatId, 'WAITING_FB_UID');
        return bot.sendMessage(chatId, "🔍 <b>Facebook UID Checker</b>\n━━━━━━━━━━━━━━━━\nSend one or multiple UIDs (separated by space or newline) to check if they are active.\n\nExample:\n<code>100083747382</code>\n<code>100092384728</code>", { parse_mode: 'HTML', ...cancelMenu });
    }

    if (text === '📊 My History') {
        const { data: history } = await supabase.from('transaction_logs').select('*').eq('telegram_id', chatId).order('created_at', { ascending: false }).limit(7);
        let msg = `👤 <b>Profile Stats</b>\n💳 <b>Credits:</b> ${user.credits}\n📞 <b>Numbers:</b> ${user.total_numbers} | 📩 <b>OTPs:</b> ${user.total_otps}\n\n📜 <b>Recent Activity:</b>\n━━━━━━━━━━━━━━━━\n`;
        
        if (history && history.length > 0) {
            history.forEach(h => {
                const date = new Date(h.created_at).toLocaleString('en-US', { timeZone: 'Asia/Dhaka' });
                msg += `🔹 <b>${h.action}</b>: <code>${h.details}</code>\n📅 <i>${date}</i>\n\n`;
            });
        } else {
            msg += "<i>No recent activity found.</i>";
        }
        return bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
    }

    if (text === '🔐 2FA Generator') {
        await setUserState(chatId, 'WAITING_2FA_SECRET');
        return bot.sendMessage(chatId, "📝 <b>Send Your Secret Key:</b>", { parse_mode: 'HTML', ...cancelMenu });
    }
}

async function processCallback(query) {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const data = query.data;
    const settings = await getSettings();
    const headers = { 'mauthapi': settings.mauth_api };

    try {
        if (data === 'dummy') return bot.answerCallbackQuery(query.id, { text: 'Copied to clipboard!' });
        if (data === 'close_msg') return bot.deleteMessage(chatId, msgId).catch(()=>{});

        if (data === 'live_traffic') {
            await bot.editMessageText(`⏳ <b>Analyzing Live Workload...</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
            const [accessRes, consoleRes] = await Promise.all([ axios.get(`${API_BASE_URL}/liveaccess`, { headers }), axios.get(`${API_BASE_URL}/console`, { headers }) ]);
            
            const hitCounts = {};
            if (consoleRes.data.data && consoleRes.data.data.hits) {
                consoleRes.data.data.hits.forEach(hit => { hitCounts[hit.range] = (hitCounts[hit.range] || 0) + 1; });
            }

            const activeServices = accessRes.data.data.services.filter(s => s.ranges && s.ranges.length > 0);
            let msg = `🚦 <b>Server Workload Status</b>\n━━━━━━━━━━━━━━━━━\n`;
            
            if (activeServices.length === 0) { 
                msg += `❌ No active traffic right now.`; 
            } else {
                activeServices.slice(0, 4).forEach(srv => {
                    msg += `📱 <b>${srv.sid.toUpperCase()}</b>\n`;
                    srv.ranges.slice(0, 5).forEach(r => {
                        const hits = hitCounts[r] || 0;
                        let status = hits >= 4 ? 'High 🟢' : (hits >= 2 ? 'Medium 🟡' : 'Low 🔴');
                        msg += `⮑ <code>${r}</code> (${status})\n`;
                    });
                    msg += '\n';
                });
            }
            return bot.editMessageText(msg, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'live_traffic' }], [{ text: '🛑 Close', callback_data: 'close_msg' }]] } });
        }

        if (data === 'getnum_manual') {
            await setUserState(chatId, 'WAITING_MANUAL_RANGE');
            await bot.deleteMessage(chatId, msgId);
            return bot.sendMessage(chatId, "⚙️ <b>Send the New Range Prefix</b>\nExample: <code>26134</code>", { parse_mode: 'HTML', reply_markup: { keyboard: [['❌ Cancel']], resize_keyboard: true } });
        }

        if (data.startsWith('req_num_')) {
            const range = data.replace('req_num_', '').replace(/X/g, '');
            await bot.editMessageText(`⏳ <b>Allocating Number from ${range}...</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
            
            try {
                const res = await axios.post(`${API_BASE_URL}/getnum`, { rid: range }, { headers });
                if (res.data && res.data.meta && res.data.meta.code !== 200) {
                    return bot.editMessageText(`❌ <b>Out of Stock for range ${range}.</b>\nTry another range.`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🛑 Close', callback_data: 'close_msg' }]]} });
                }
                
                const numData = res.data.data;
                const fullNum = numData.full_number;
                const cInfo = getCountryByRange(range);
                
                let { data: userStats } = await supabase.from('bot_users').select('total_numbers, credits').eq('telegram_id', chatId).single();
                await supabase.from('bot_users').update({ total_numbers: (userStats.total_numbers || 0) + 1 }).eq('telegram_id', chatId);
                
                await supabase.from('active_numbers').insert([{ telegram_id: chatId, full_number: fullNum, range_prefix: range }]);
                await logAction(chatId, 'Number Acquired', `${fullNum} (${range})`);

                const msgText = `🌐 <b>SERVICE ACQUIRED</b>\n━━━━━━━━━━━━━━━━\n🌍 <b>Location:</b> ${cInfo.flag} ${cInfo.name}\n📞 <b>Number:</b> <code>${fullNum}</code>\n\n<i>Click below for instant OTP fetch.</i>`;
                const kb = { inline_keyboard: [
                    [{ text: '📩 Get OTP (Instant)', callback_data: `chk_otp_${fullNum}` }],
                    [{ text: '🛑 Close', callback_data: 'close_msg' }]
                ]};
                return bot.editMessageText(msgText, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: kb });
            } catch (err) {
                return bot.editMessageText(`❌ <b>API Error! Server issue or invalid range.</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🛑 Close', callback_data: 'close_msg' }]]} });
            }
        }

        if (data.startsWith('chk_otp_')) {
            const targetNum = data.replace('chk_otp_', '');
            
            // INSTANT PROCESSING: Shows message and checks API exactly ONCE immediately.
            const statusMsg = await bot.sendMessage(chatId, `⏳ <b>Processing...</b>`, { parse_mode: 'HTML' });
            
            let otpFound = null;
            let cleanNum = targetNum.replace('+', '').trim();

            try {
                const res = await axios.get(`${API_BASE_URL}/success-otp`, { headers });
                if(res.data && res.data.data && res.data.data.otps) {
                    otpFound = res.data.data.otps.find(o => o.number && o.number.includes(cleanNum));
                }
            } catch(e) {}

            // Instantly delete processing message (within 1 second)
            await bot.deleteMessage(chatId, statusMsg.message_id).catch(()=>{});

            if (otpFound) {
                let { data: userStats } = await supabase.from('bot_users').select('total_otps, credits').eq('telegram_id', chatId).single();
                // Subtract 1 credit for successful OTP
                const newCredits = (userStats.credits > 0) ? userStats.credits - 1 : 0;
                
                await supabase.from('bot_users').update({ total_otps: (userStats.total_otps || 0) + 1, credits: newCredits }).eq('telegram_id', chatId);
                await supabase.from('active_numbers').update({ status: 'COMPLETED' }).eq('telegram_id', chatId).eq('full_number', targetNum);
                await logAction(chatId, 'OTP Received', targetNum);

                const smsg = `✅ <b>OTP RECEIVED!</b>\n━━━━━━━━━━━━━━━━\n📞 Number: <code>${targetNum}</code>\n💬 OTP: <code>${otpFound.message}</code>\n💳 Remaining Credits: ${newCredits}`;
                return bot.editMessageText(smsg, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: `📋 Copy Code: ${otpFound.message}`, callback_data: 'dummy' }]]} });
            } else {
                const fmsg = `⏳ <b>Not Received Yet.</b>\n📞 <code>${targetNum}</code>`;
                return bot.editMessageText(fmsg, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔄 Check Again', callback_data: `chk_otp_${targetNum}` }]]} });
            }
        }

        if (data.startsWith('cancel_num_')) {
            const dbId = data.replace('cancel_num_', '');
            await supabase.from('active_numbers').update({ status: 'CANCELLED_BAD' }).eq('id', dbId);
            await logAction(chatId, 'Number Cancelled', `Session ID: ${dbId}`);
            
            await bot.answerCallbackQuery(query.id, { text: 'Number marked as bad and cancelled!', show_alert: true });
            await bot.deleteMessage(chatId, msgId).catch(()=>{});
        }

    } catch (err) { console.error("Process Callback Error:", err.message); }
}

module.exports = async (req, res) => {
    if (req.method === 'POST') {
        try {
            const update = req.body;
            if (update.message) await processMessage(update.message);
            else if (update.callback_query) await processCallback(update.callback_query);
        } catch (error) { console.error(error); }
    }
    res.status(200).send('OK');
};
