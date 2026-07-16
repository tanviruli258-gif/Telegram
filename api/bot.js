process.env.NTBA_FIX_319 = 1;
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// ============================================================================
// 1. SYSTEM CONFIGURATIONS & ENVIRONMENT VARIABLES
// ============================================================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(Number) : []; 
const API_BASE_URL = 'https://api.2oo9.cloud/MXS47FLFX0U/tness/@public/api';

const bot = new TelegramBot(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// ============================================================================
// 2. UI / MENUS & KEYBOARDS (PROFESSIONAL LAYOUT)
// ============================================================================
const getMainMenu = (isAdmin) => {
    const kb = [
        ['🔢 Get Number', '📱 Active Sessions'],
        ['🔍 FB UID Checker', '📊 My Profile'],
        ['🎁 Daily Bonus', '🔗 Invite Friends']
    ];
    if (isAdmin) kb.push(['⚙️ Admin Panel']);
    return { reply_markup: { keyboard: kb, resize_keyboard: true } };
};

const adminMenu = { 
    reply_markup: { 
        keyboard: [
            ['🌐 API Setup', '📢 Broadcast'], 
            ['💳 Manage Credits', '🚫 Ban / Unban User'],
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
        user = { telegram_id: chatId, credits: 10, saved_range: null, current_state: null, total_numbers: 0, total_otps: 0 };
        await supabase.from('bot_users').insert([user]);
    }
    return user;
}

async function updateState(chatId, state) {
    await supabase.from('bot_users').update({ current_state: state }).eq('telegram_id', chatId);
}

async function logTransaction(chatId, action, details) {
    await supabase.from('transaction_logs').insert([{ telegram_id: chatId, action: action, details: details }]);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// 4. MAIN MESSAGE PROCESSOR (COMMANDS & STATES)
// ============================================================================
async function processMessage(msg) {
    const chatId = msg.chat.id;
    const text = msg.text || '';
    const isAdmin = ADMIN_IDS.includes(Number(chatId));

    if (!text) return;

    const user = await getUser(chatId);
    const mainMenu = getMainMenu(isAdmin);

    // Global Cancel Action
    if (text === '❌ Cancel' || text === '🔙 Back to Main') {
        await updateState(chatId, null);
        return bot.sendMessage(chatId, "🏠 <b>Returned to Main Menu.</b>", { parse_mode: 'HTML', ...mainMenu });
    }

    if (user.is_banned) {
        return bot.sendMessage(chatId, "🚫 <b>Your account has been permanently banned by the Admin.</b>", { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });
    }

    // ------------------------------------------------------------------------
    // STATE MANAGEMENT ENGINE (Handling User Inputs)
    // ------------------------------------------------------------------------
    const state = user.current_state;

    if (state === 'WAITING_RANGE') {
        const range = text.trim().toUpperCase().replace(/X/g, '');
        if(isNaN(range)) return bot.sendMessage(chatId, "⚠️ <b>Invalid range! Please send numbers only.</b>", { parse_mode: 'HTML' });
        
        await supabase.from('bot_users').update({ current_state: null, saved_range: range }).eq('telegram_id', chatId);
        const kb = { reply_markup: { inline_keyboard: [[{ text: `🚀 Get Number from ${range}`, callback_data: `req_num_${range}` }]] } };
        return bot.sendMessage(chatId, `✅ <b>Range Successfully Saved:</b> <code>${range}</code>\n\n<i>You can now fetch numbers seamlessly.</i>`, { parse_mode: 'HTML', ...mainMenu, ...kb });
    }

    if (state === 'WAITING_FB_UID') {
        const uids = text.split(/[\n, ]+/).map(u => u.trim()).filter(u => u);
        if(uids.length === 0) return bot.sendMessage(chatId, "⚠️ <b>No valid UIDs found in your text.</b>", { parse_mode: 'HTML' });
        if(uids.length > 30) return bot.sendMessage(chatId, "⚠️ <b>Limit exceeded! Please send a maximum of 30 UIDs per request.</b>", { parse_mode: 'HTML' });
        
        const statusMsg = await bot.sendMessage(chatId, `🔍 <b>Scanning ${uids.length} UIDs...</b>\n<i>Please wait, communicating with Facebook Graph API...</i>`, { parse_mode: 'HTML' });
        let resultText = `📋 <b>FB UID Audit Report:</b>\n━━━━━━━━━━━━━━━━━\n`;
        let activeCount = 0;
        let badCount = 0;
        
        for(let uid of uids) {
            try {
                const res = await axios.get(`https://graph.facebook.com/${uid}/picture?redirect=false`, { validateStatus: () => true });
                if (res.data && res.data.data && res.data.data.url && !res.data.data.is_silhouette) {
                    resultText += `✅ <code>${uid}</code> - <b>Active</b>\n`;
                    activeCount++;
                } else {
                    resultText += `❌ <code>${uid}</code> - <b>Banned / Not Found</b>\n`;
                    badCount++;
                }
            } catch(e) {
                resultText += `⚠️ <code>${uid}</code> - <b>Connection Error</b>\n`;
            }
        }
        resultText += `\n📊 <b>Summary:</b> Active: <b>${activeCount}</b> | Bad: <b>${badCount}</b>`;
        await logTransaction(chatId, 'FB UID Checker', `Checked ${uids.length} IDs`);
        return bot.editMessageText(resultText, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' });
    }

    // Admin States
    if (isAdmin) {
        if (state === 'WAITING_API_KEY') {
            await supabase.from('bot_settings').update({ mauth_api: text.trim() }).eq('id', 1);
            await updateState(chatId, null);
            return bot.sendMessage(chatId, "✅ <b>Master API Key Updated Successfully!</b>", { parse_mode: 'HTML', ...adminMenu });
        }
        if (state === 'WAITING_BROADCAST') {
            await updateState(chatId, `CONFIRM_BCAST:${text}`);
            return bot.sendMessage(chatId, `📢 <b>Broadcast Preview:</b>\n\n${text}\n\n<i>Are you sure you want to send this to ALL users?</i>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✅ Send Now', callback_data: 'run_bcast' }, { text: '❌ Cancel', callback_data: 'close' }]] } });
        }
        if (state === 'WAITING_MANAGE_CREDIT') {
            const parts = text.split(' ');
            if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) {
                return bot.sendMessage(chatId, "⚠️ <b>Format error.</b> Send: <code>TelegramID Amount</code>", { parse_mode: 'HTML' });
            }
            const targetId = Number(parts[0]);
            const amount = Number(parts[1]);
            
            let { data: targetUser } = await supabase.from('bot_users').select('credits').eq('telegram_id', targetId).single();
            if (!targetUser) return bot.sendMessage(chatId, "❌ User not found in database.", { parse_mode: 'HTML' });
            
            const newBal = (targetUser.credits || 0) + amount;
            await supabase.from('bot_users').update({ credits: newBal }).eq('telegram_id', targetId);
            await updateState(chatId, null);
            
            bot.sendMessage(targetId, `💰 <b>Admin has updated your balance!</b>\nYour new balance: <b>${newBal} Credits</b>`, { parse_mode: 'HTML' }).catch(()=>{});
            return bot.sendMessage(chatId, `✅ <b>Success!</b>\nUser: <code>${targetId}</code>\nNew Balance: ${newBal}`, { parse_mode: 'HTML', ...adminMenu });
        }
        if (state === 'WAITING_BAN_USER') {
            const targetId = Number(text.trim());
            await supabase.from('bot_users').update({ is_banned: true }).eq('telegram_id', targetId);
            await updateState(chatId, null);
            return bot.sendMessage(chatId, `🚫 <b>User <code>${targetId}</code> has been banned.</b>`, { parse_mode: 'HTML', ...adminMenu });
        }
    }

    // ------------------------------------------------------------------------
    // MAIN USER MENU COMMANDS
    // ------------------------------------------------------------------------
    if (text.startsWith('/start')) {
        const refId = text.split(' ')[1];
        if (refId && Number(refId) !== chatId) {
            // Check if newly joined to give referral bonus
            const now = new Date();
            const joined = new Date(user.joined_at);
            if ((now - joined) < 60000) { // If joined within last 60 seconds
                let { data: referrer } = await supabase.from('bot_users').select('credits').eq('telegram_id', Number(refId)).single();
                if (referrer) {
                    await supabase.from('bot_users').update({ credits: referrer.credits + 2 }).eq('telegram_id', Number(refId));
                    bot.sendMessage(Number(refId), `🎉 <b>Referral Success!</b>\nA new user joined via your link. You got <b>+2 Credits!</b>`, { parse_mode: 'HTML' }).catch(()=>{});
                }
            }
        }
        const wlcMsg = `🌟 <b>Welcome to Enterprise SMS & Management Portal!</b>\n\n💼 We provide lightning-fast OTPs and Bulk FB checking utilities. Let's get started.`;
        return bot.sendMessage(chatId, wlcMsg, { parse_mode: 'HTML', ...mainMenu });
    }
    
    if (text === '🔢 Get Number') {
        let msg = "📞 <b>Service Acquisition Terminal:</b>\n━━━━━━━━━━━━━━━━━\n";
        const kb = [];
        if (user.saved_range) {
            msg += `💾 <b>Active Range:</b> <code>${user.saved_range}</code>\n`;
            msg += `💰 <b>Your Credits:</b> ${user.credits}\n\n<i>Click below to bypass queues and fetch a number instantly.</i>`;
            kb.push([{ text: `🚀 Fetch Number (${user.saved_range})`, callback_data: `req_num_${user.saved_range}` }]);
        } else {
            msg += `⚠️ <i>No working range is configured on your profile.</i>\n`;
        }
        kb.push([{ text: '⚙️ Configure Range Profile', callback_data: 'change_range' }]);
        return bot.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    }

    if (text === '🔍 FB UID Checker') {
        await updateState(chatId, 'WAITING_FB_UID');
        const guideMsg = `🔍 <b>Bulk FB UID Analyzer Engine</b>\n━━━━━━━━━━━━━━━━━\nSend the UIDs you want to verify.\n\n💡 <b>Pro Tip:</b> You can copy-paste up to 30 UIDs at once, separated by lines or spaces. The system will process them concurrently.\n\n<i>Click Cancel below to exit this mode.</i>`;
        return bot.sendMessage(chatId, guideMsg, { parse_mode: 'HTML', ...cancelMenu });
    }

    if (text === '📱 Active Sessions') {
        const { data: active } = await supabase.from('active_numbers').select('*').eq('telegram_id', chatId).eq('status', 'PENDING').order('created_at', { ascending: false }).limit(5);
        if (!active || active.length === 0) return bot.sendMessage(chatId, "📭 <b>No pending SMS sessions in the queue.</b>", { parse_mode: 'HTML' });
        
        let msg = "📱 <b>Your Live Sessions:</b>\n\n";
        const kb = [];
        active.forEach(n => {
            kb.push([{ text: `📩 Retrieve OTP: ${n.full_number}`, callback_data: `chk_otp_${n.full_number}` }]);
            kb.push([{ text: `🚫 Report Bad Number (Refund)`, callback_data: `report_bad_${n.full_number}_${n.id}` }]);
        });
        return bot.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    }

    if (text === '📊 My Profile') {
        const joinedDate = new Date(user.joined_at).toLocaleDateString('en-US');
        const profMsg = `👤 <b>Executive Profile Dashboard</b>\n━━━━━━━━━━━━━━━━━\n🆔 <b>Account ID:</b> <code>${chatId}</code>\n📅 <b>Member Since:</b> ${joinedDate}\n\n💰 <b>Available Credits:</b> ${user.credits}\n📞 <b>Numbers Generated:</b> ${user.total_numbers}\n📩 <b>OTPs Decoded:</b> ${user.total_otps}\n💾 <b>Default Range:</b> ${user.saved_range || 'Not Configured'}`;
        return bot.sendMessage(chatId, profMsg, { parse_mode: 'HTML' });
    }

    if (text === '🎁 Daily Bonus') {
        const todayStr = new Date().toISOString().split('T')[0];
        let { data: lastClaim } = await supabase.from('transaction_logs').select('created_at').eq('telegram_id', chatId).eq('action', 'Daily Bonus').like('created_at', `${todayStr}%`).single();
        
        if (lastClaim) {
            return bot.sendMessage(chatId, "⏳ <b>You have already claimed your daily bonus today. Come back tomorrow!</b>", { parse_mode: 'HTML' });
        }
        
        const newCred = user.credits + 1;
        await supabase.from('bot_users').update({ credits: newCred }).eq('telegram_id', chatId);
        await logTransaction(chatId, 'Daily Bonus', '+1 Credit');
        return bot.sendMessage(chatId, "🎉 <b>Daily Bonus Claimed!</b>\n<b>+1 Credit</b> has been added to your account.", { parse_mode: 'HTML' });
    }

    if (text === '🔗 Invite Friends') {
        const botInfo = await bot.getMe();
        const refLink = `https://t.me/${botInfo.username}?start=${chatId}`;
        const refMsg = `🤝 <b>Enterprise Referral Program</b>\n━━━━━━━━━━━━━━━━━\nShare this link with your network and earn <b>+2 Credits</b> for every new user who joins!\n\n🔗 <b>Your Link:</b>\n<code>${refLink}</code>`;
        return bot.sendMessage(chatId, refMsg, { parse_mode: 'HTML' });
    }

    // ------------------------------------------------------------------------
    // ADMIN COMMANDS EXECUTION
    // ------------------------------------------------------------------------
    if (isAdmin) {
        if (text === '⚙️ Admin Panel') return bot.sendMessage(chatId, "🔐 <b>Admin Control Center Authorized.</b>", { parse_mode: 'HTML', ...adminMenu });
        
        if (text === '🌐 API Setup') {
            await updateState(chatId, 'WAITING_API_KEY');
            return bot.sendMessage(chatId, "🔑 <b>Please provide the Master mauthapi Key to connect to the panel:</b>", { parse_mode: 'HTML', ...cancelMenu });
        }
        if (text === '📢 Broadcast') {
            await updateState(chatId, 'WAITING_BROADCAST');
            return bot.sendMessage(chatId, "📢 <b>Send the message (Supports HTML formatting):</b>", { parse_mode: 'HTML', ...cancelMenu });
        }
        if (text === '💳 Manage Credits') {
            await updateState(chatId, 'WAITING_MANAGE_CREDIT');
            return bot.sendMessage(chatId, "💳 <b>To Add/Remove Credits, send in this format:</b>\n<code>TelegramID Amount</code>\n\nExample to add 10: <code>123456789 10</code>\nExample to remove 5: <code>123456789 -5</code>", { parse_mode: 'HTML', ...cancelMenu });
        }
        if (text === '🚫 Ban / Unban User') {
            await updateState(chatId, 'WAITING_BAN_USER');
            return bot.sendMessage(chatId, "🚫 <b>Send the Telegram ID of the user to Ban:</b>", { parse_mode: 'HTML', ...cancelMenu });
        }
        if (text === '📈 Global Stats') {
            const { data: users } = await supabase.from('bot_users').select('total_otps, total_numbers, credits');
            let tOtp = 0, tNum = 0, tCred = 0;
            users.forEach(u => { tOtp += u.total_otps; tNum += u.total_numbers; tCred += u.credits; });
            return bot.sendMessage(chatId, `📊 <b>Global Enterprise Matrix</b>\n━━━━━━━━━━━━━━━━━\n👥 <b>Total Accounts:</b> ${users.length}\n📞 <b>Total Generations:</b> ${tNum}\n📩 <b>Total Validations (OTP):</b> ${tOtp}\n💳 <b>Total Credits Floating:</b> ${tCred}`, { parse_mode: 'HTML' });
        }
    }
}

// ============================================================================
// 5. CALLBACK / INLINE BUTTON PROCESSOR
// ============================================================================
async function processCallback(query) {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const data = query.data;
    
    // Safety close
    if(data === 'close') return bot.deleteMessage(chatId, msgId).catch(()=>{});

    // Handle Range Modification
    if (data === 'change_range') {
        await updateState(chatId, 'WAITING_RANGE');
        await bot.deleteMessage(chatId, msgId).catch(()=>{});
        return bot.sendMessage(chatId, "⚙️ <b>Please input the new country/network prefix (e.g., 26134):</b>", { parse_mode: 'HTML', ...cancelMenu });
    }

    // Handle Admin Broadcast
    if (data === 'run_bcast' && ADMIN_IDS.includes(Number(chatId))) {
        let { data: userState } = await supabase.from('bot_users').select('current_state').eq('telegram_id', chatId).single();
        if (userState && userState.current_state && userState.current_state.startsWith('CONFIRM_BCAST:')) {
            const bMsg = userState.current_state.replace('CONFIRM_BCAST:', '');
            await updateState(chatId, null);
            await bot.editMessageText(`⏳ <b>Initiating Mass Broadcast Sequence...</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
            
            const { data: users } = await supabase.from('bot_users').select('telegram_id');
            let s = 0, f = 0;
            for (const u of users) {
                try { await bot.sendMessage(u.telegram_id, bMsg, { parse_mode: 'HTML' }); s++; } 
                catch(e){ f++; }
                await delay(35); // Prevent Telegram rate limits (30 msgs/sec max)
            }
            return bot.editMessageText(`📢 <b>Broadcast Completed Successfully!</b>\n✅ Delivered: ${s}\n❌ Failed: ${f}`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
        }
    }

    // ------------------------------------------------------------------------
    // CORE API INTEGRATION: FETCH NUMBER
    // ------------------------------------------------------------------------
    if (data.startsWith('req_num_')) {
        let { data: user } = await supabase.from('bot_users').select('credits').eq('telegram_id', chatId).single();
        if (user.credits <= 0) {
            return bot.editMessageText(`❌ <b>Transaction Denied: Insufficient Credits.</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
        }

        const range = data.replace('req_num_', '');
        await bot.editMessageText(`⏳ <b>Establishing secure connection and allocating number from <code>${range}</code>...</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
        
        try {
            const { data: settings } = await supabase.from('bot_settings').select('mauth_api').eq('id', 1).single();
            if (!settings || !settings.mauth_api) {
                return bot.editMessageText(`❌ <b>System Error: API Routing Key is missing. Contact Admin.</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
            }

            const headers = { 'mauthapi': settings.mauth_api };
            const res = await axios.post(`${API_BASE_URL}/getnum`, { rid: range }, { headers });
            
            if (res.data && res.data.meta && res.data.meta.code !== 200) {
                return bot.editMessageText(`❌ <b>Inventory Error: The specified range <code>${range}</code> is currently out of stock.</b>\nPlease try again shortly.`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
            }
            
            const fullNum = res.data.data.full_number;
            await supabase.from('active_numbers').insert([{ telegram_id: chatId, full_number: fullNum, range_prefix: range }]);
            await supabase.from('bot_users').update({ total_numbers: (user.total_numbers || 0) + 1 }).eq('telegram_id', chatId);
            await logTransaction(chatId, 'Number Generated', `${fullNum} (${range})`);

            const msgText = `🌐 <b>SERVICE ACQUIRED SUCCESSFULLY</b>\n━━━━━━━━━━━━━━━━━\n📞 <b>Number:</b> <code>${fullNum}</code>\n📡 <b>Range:</b> <code>${range}</code>\n\n<i>Waiting for inbound SMS. Click below to fetch instantly.</i>`;
            const kb = { inline_keyboard: [
                [{ text: '📩 Decode OTP (Instant)', callback_data: `chk_otp_${fullNum}` }], 
                [{ text: '🚫 Report Bad Number (Refund)', callback_data: `report_bad_${fullNum}_new` }],
                [{ text: '🛑 Close Terminal', callback_data: 'close' }]
            ]};
            return bot.editMessageText(msgText, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: kb });
        } catch(e) {
            return bot.editMessageText(`❌ <b>Network Protocol Error! Verification server is unreachable.</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
        }
    }

    // ------------------------------------------------------------------------
    // CORE API INTEGRATION: FETCH OTP (1-SECOND INSTANT)
    // ------------------------------------------------------------------------
    if (data.startsWith('chk_otp_')) {
        const num = data.replace('chk_otp_', '');
        const cleanNum = num.replace('+', '').trim();
        
        // Instant Processing Feedback
        const pMsg = await bot.sendMessage(chatId, `⏳ <b>Intercepting SMS data...</b>`, { parse_mode: 'HTML' });
        
        try {
            const { data: settings } = await supabase.from('bot_settings').select('mauth_api').eq('id', 1).single();
            const headers = { 'mauthapi': settings.mauth_api };

            // Single fast API call
            const res = await axios.get(`${API_BASE_URL}/success-otp`, { headers });
            let otpFound = null;
            if(res.data && res.data.data && res.data.data.otps) {
                otpFound = res.data.data.otps.find(o => o.number && o.number.includes(cleanNum));
            }
            
            // Clean up processing text immediately
            await bot.deleteMessage(chatId, pMsg.message_id).catch(()=>{});

            if (otpFound) {
                let { data: u } = await supabase.from('bot_users').select('total_otps, credits').eq('telegram_id', chatId).single();
                
                // Deduct 1 Credit upon success
                await supabase.from('bot_users').update({ total_otps: (u.total_otps || 0) + 1, credits: Math.max(0, u.credits - 1) }).eq('telegram_id', chatId);
                await supabase.from('active_numbers').update({ status: 'COMPLETED' }).eq('telegram_id', chatId).eq('full_number', num);
                await logTransaction(chatId, 'OTP Success', `Number: ${num}`);

                const smsg = `✅ <b>VALIDATION COMPLETE!</b>\n━━━━━━━━━━━━━━━━━\n📞 <b>Target:</b> <code>${num}</code>\n💬 <b>Code:</b> <code>${otpFound.message}</code>\n\n💰 <i>System charged 1 Credit for this transaction.</i>`;
                return bot.editMessageText(smsg, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
            } else {
                return bot.sendMessage(chatId, `⏳ <b>Signal Not Found. SMS has not arrived yet for <code>${num}</code>.</b>`, { parse_mode: 'HTML' });
            }
        } catch(e) {
            await bot.deleteMessage(chatId, pMsg.message_id).catch(()=>{});
            return bot.sendMessage(chatId, `❌ <b>Decryption Engine Error.</b> Try again.`, { parse_mode: 'HTML' });
        }
    }

    // ------------------------------------------------------------------------
    // AUTO-REFUND & BAD NUMBER REPORTING
    // ------------------------------------------------------------------------
    if (data.startsWith('report_bad_')) {
        const parts = data.split('_');
        const num = parts[2];
        const dbId = parts[3]; // Can be 'new' or actual ID from Active Sessions

        // Cancel in DB if ID exists
        if (dbId !== 'new') {
            await supabase.from('active_numbers').update({ status: 'CANCELLED_BAD' }).eq('id', Number(dbId));
        }

        await logTransaction(chatId, 'Bad Number Reported', num);
        await bot.answerCallbackQuery(query.id, { text: 'Number marked as invalid. No credits were deducted.', show_alert: true });
        return bot.editMessageText(`🚫 <b>Session Terminated.</b>\nNumber <code>${num}</code> has been flagged as bad.\n\n<i>Your credits are safe and have not been deducted.</i>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
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
    // Always return 200 OK so Telegram stops resending the same update
    res.status(200).send('OK');
};
