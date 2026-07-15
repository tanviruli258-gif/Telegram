process.env.NTBA_FIX_319 = 1;
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const axios = require('axios');
const { authenticator } = require('otplib');

// ================= CONFIGURATION =================
const BOT_TOKEN = '8507943641:AAExcRBGKxXvEz3R0f5t6u8uHxlpCKW6fPo';
const ADMIN_IDS = [7392861032]; 
const SUPABASE_URL = 'https://ixptyhyaciqcymkejiey.supabase.co';
const SUPABASE_SECRET_KEY = 'sb_publishable_M67GpIfk5KYume0uNQZOUQ_hvn79_1v'; 
const API_BASE_URL = 'https://api.2oo9.cloud/MXS47FLFX0U/tness/@public/api';
// =================================================

const bot = new TelegramBot(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// --- Keyboards ---
const adminMainMenu = { reply_markup: { keyboard: [['📱 Fix Number', '🔢 Get Number'], ['🔐 2FA Generator', '📊 My Stats'], ['🎧 Support', '⚙️ Admin Panel']], resize_keyboard: true } };
const userMainMenu = { reply_markup: { keyboard: [['📱 Fix Number', '🔢 Get Number'], ['🔐 2FA Generator', '📊 My Stats'], ['🎧 Support']], resize_keyboard: true } };
const cancelMenu = { reply_markup: { keyboard: [['❌ Cancel']], resize_keyboard: true } };

// Organized Admin Panel
const adminMenu = { 
    reply_markup: { 
        keyboard: [['⚙️ Bot Config', '🌐 API & Email'], ['👥 User Manage', '🔙 Back to Main']], resize_keyboard: true 
    }
};
const botConfigMenu = { reply_markup: { keyboard: [['📝 WLC MESSAGE EDIT', '⚙️ BOT ON/OFF'], ['📊 LIMIT USER', '🔙 Admin Home']], resize_keyboard: true } };
const apiEmailMenu = { reply_markup: { keyboard: [['🎯 Set Target Email', '📧 SMTP Setup'], ['🔌 API Setup', '🔙 Admin Home']], resize_keyboard: true } };
const userManageMenu = { reply_markup: { keyboard: [['📢 Broadcast', '🔗 Generate Invite'], ['✅ Approve User', '🚫 Ban/Remove User'], ['🗑 Clear Database', '🔙 Admin Home']], resize_keyboard: true } };

// --- Helper Functions ---
async function getSettings() {
    const { data } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
    return data || {};
}
async function setUserState(chatId, state) {
    await supabase.from('bot_users').update({ current_state: state }).eq('telegram_id', chatId);
}

// Country Mapper for Auto Range
function getCountryByRange(range) {
    const r = range.replace('XXX', '');
    if(r.startsWith('224')) return { name: 'Guinea', flag: '🇬🇳', code: r };
    if(r.startsWith('225')) return { name: 'Ivory Coast', flag: '🇨🇮', code: r };
    if(r.startsWith('229')) return { name: 'Benin', flag: '🇧🇯', code: r };
    if(r.startsWith('251')) return { name: 'Ethiopia', flag: '🇪🇹', code: r };
    if(r.startsWith('236')) return { name: 'CAR', flag: '🇨🇫', code: r };
    if(r.startsWith('880')) return { name: 'Bangladesh', flag: '🇧🇩', code: r };
    if(r.startsWith('44')) return { name: 'UK', flag: '🇬🇧', code: r };
    if(r.startsWith('1')) return { name: 'USA/CA', flag: '🇺🇸', code: r };
    return { name: `Global (${r})`, flag: '🌐', code: r };
}

// --- Message Processor ---
async function processMessage(msg) {
    const chatId = msg.chat.id;
    const text = msg.text;
    const isAdmin = ADMIN_IDS.includes(Number(chatId));
    if (!text) return;

    const settings = await getSettings();
    const currentMenu = isAdmin ? adminMainMenu : userMainMenu;

    let { data: user } = await supabase.from('bot_users').select('*').eq('telegram_id', chatId).single();
    const today = new Date().toISOString().split('T')[0];

    if (!user) {
        user = { telegram_id: chatId, is_approved: isAdmin, is_admin: isAdmin, is_banned: false, sms_count: 0, last_reset: today, current_state: null, total_numbers: 0, total_otps: 0 };
        await supabase.from('bot_users').insert([user]);
    } else if (user.last_reset !== today) {
        await supabase.from('bot_users').update({ sms_count: 0, last_reset: today }).eq('telegram_id', chatId);
        user.sms_count = 0;
    }

    if (user.is_banned) return bot.sendMessage(chatId, "❌ <b>You are permanently banned.</b>", { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } });

    if (text === '❌ Cancel' || text === '🔙 Back to Main') {
        await setUserState(chatId, null);
        return bot.sendMessage(chatId, "🏠 <b>Main Menu</b>", { parse_mode: 'HTML', ...currentMenu });
    }
    if (text === '🔙 Admin Home') {
        await setUserState(chatId, null);
        return bot.sendMessage(chatId, "⚙️ <b>Admin Panel</b>", { parse_mode: 'HTML', ...adminMenu });
    }

    // STATE MANAGEMENT (Inputs)
    if (user.current_state) {
        const state = user.current_state;
        
        // --- PUBLIC STATES ---
        if (state === 'WAITING_SECRET_CODE') {
            const { data: invite } = await supabase.from('bot_invites').select('*').eq('code', text).single();
            if (invite && invite.is_active && invite.current_uses < invite.max_uses) {
                await supabase.from('bot_users').update({ is_approved: true, current_state: null }).eq('telegram_id', chatId);
                await supabase.from('bot_invites').update({ current_uses: invite.current_uses + 1 }).eq('code', text);
                if (invite.current_uses + 1 >= invite.max_uses) await supabase.from('bot_invites').update({ is_active: false }).eq('code', text);
                return bot.sendMessage(chatId, "✅ <b>VIP Access Granted! You can now use Fix Number.</b>", { parse_mode: 'HTML', ...currentMenu });
            } else {
                return bot.sendMessage(chatId, "❌ <b>Invalid or expired code. Please try again or click Cancel.</b>", { parse_mode: 'HTML', ...cancelMenu });
            }
        }
        
        if (state === 'WAITING_NUMBER') {
            await setUserState(chatId, null);
            if (user.sms_count >= (settings.default_msg_limit || 2) && !isAdmin) {
                return bot.sendMessage(chatId, `⚠️ <b>Your daily limit is reached.</b>\nCome back tomorrow!`, { parse_mode: 'HTML', ...currentMenu });
            }
            const num = text.trim();
            const confirmNumberMenu = { reply_markup: { inline_keyboard: [[{ text: '📩 Send Message', callback_data: `sendmsg_${num}` }]] } };
            return bot.sendMessage(chatId, `📞 <b>Number:</b> <code>${num}</code>\n\n<i>Click the button below to send the request.</i>`, { parse_mode: 'HTML', ...confirmNumberMenu });
        }

        if (state === 'WAITING_2FA_SECRET') {
            await setUserState(chatId, null);
            try {
                const cleanSecret = text.replace(/\s+/g, '').toUpperCase();
                const code = authenticator.generate(cleanSecret);
                const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
                
                const msg = `🌟 <b>2FA Generator</b>\n━━━━━━━━━━━━━━━━━━\n🛡️ <b>Secret Key:</b> <code>${cleanSecret}</code>\n🔑 <b>Auth Code:</b> <code>${code}</code>\n📅 <b>Time:</b> ${time}`;
                const copyBtn = { reply_markup: { inline_keyboard: [[{ text: '📋 Copy Code', callback_data: 'dummy_btn' }]] } };
                return bot.sendMessage(chatId, msg, { parse_mode: 'HTML', ...copyBtn, ...currentMenu });
            } catch (err) {
                return bot.sendMessage(chatId, "❌ <b>Invalid Secret Key format.</b>", { parse_mode: 'HTML', ...currentMenu });
            }
        }

        if (state === 'WAITING_MANUAL_RANGE') {
            await setUserState(chatId, null);
            const range = text.trim();
            await bot.sendMessage(chatId, `⏳ <b>Fetching number from range ${range}...</b>`, { parse_mode: 'HTML' }).then(m => {
                processCallback({ message: { chat: { id: chatId }, message_id: m.message_id }, data: `req_num_${range}` });
            });
            return;
        }

        // --- ADMIN STATES ---
        if (isAdmin) {
            try {
                if (state === 'WAITING_API_KEY') {
                    await setUserState(chatId, null);
                    await bot.sendMessage(chatId, "⏳ <b>Verifying API Key...</b>", { parse_mode: 'HTML' });
                    try {
                        const res = await axios.get(`${API_BASE_URL}/liveaccess`, { headers: { 'mauthapi': text.trim() } });
                        if(res.data.meta && res.data.meta.code === 200) {
                            await supabase.from('bot_settings').update({ mauth_api: text.trim() }).eq('id', 1);
                            return bot.sendMessage(chatId, `✅ <b>API Connected Successfully!</b>\nServices detected: ${res.data.data.services.length}`, { parse_mode: 'HTML', ...apiEmailMenu });
                        }
                    } catch (e) {
                        return bot.sendMessage(chatId, `❌ <b>Invalid API Key or connection error.</b>`, { parse_mode: 'HTML', ...apiEmailMenu });
                    }
                }
                if (state === 'WAITING_WLC') { await setUserState(chatId, null); await supabase.from('bot_settings').update({ welcome_msg: text }).eq('id', 1); return bot.sendMessage(chatId, "✅ <b>Saved!</b>", { parse_mode: 'HTML', ...botConfigMenu }); }
                if (state === 'WAITING_LIMIT') { await setUserState(chatId, null); await supabase.from('bot_settings').update({ default_msg_limit: parseInt(text) }).eq('id', 1); return bot.sendMessage(chatId, `✅ <b>Saved!</b>`, { parse_mode: 'HTML', ...botConfigMenu }); }
                if (state === 'WAITING_INVITE_COUNT') { await setUserState(chatId, null); const code = 'VIP_' + Math.random().toString(36).substr(2, 6).toUpperCase(); await supabase.from('bot_invites').insert([{ code: code, max_uses: parseInt(text) }]); return bot.sendMessage(chatId, `🔗 <b>Invite Generated!</b>\nCode: <code>${code}</code>\nMax Uses: ${parseInt(text)}`, { parse_mode: 'HTML', ...userManageMenu }); }
                if (state === 'WAITING_TARGET_EMAIL') { await setUserState(chatId, null); await supabase.from('bot_settings').update({ target_email: text }).eq('id', 1); return bot.sendMessage(chatId, `✅ <b>Saved!</b>`, { parse_mode: 'HTML', ...apiEmailMenu }); }
                if (state === 'WAITING_SMTP_CREDS') { await setUserState(chatId, null); const lines = text.split('\n'); await supabase.from('bot_settings').update({ smtp_user: lines[0].trim(), smtp_pass: lines[1].trim() }).eq('id', 1); return bot.sendMessage(chatId, `✅ <b>Saved!</b>`, { parse_mode: 'HTML', ...apiEmailMenu }); }
                if (state === 'WAITING_BROADCAST') { await setUserState(chatId, 'PENDING_BCAST:' + text); return bot.sendMessage(chatId, `<b>Message Preview:</b>\n\n${text}\n\n<i>Confirm to send.</i>`, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '📢 Confirm', callback_data: `run_bcast` }]] } }); }
                if (state === 'WAITING_APPROVE_ID') { await setUserState(chatId, null); await supabase.from('bot_users').update({ is_approved: true }).eq('telegram_id', parseInt(text)); return bot.sendMessage(chatId, `✅ <b>Approved.</b>`, { parse_mode: 'HTML', ...userManageMenu }); }
                if (state === 'WAITING_BAN_ID') { await setUserState(chatId, null); await supabase.from('bot_users').update({ is_banned: true }).eq('telegram_id', parseInt(text)); return bot.sendMessage(chatId, `🚫 <b>Banned.</b>`, { parse_mode: 'HTML', ...userManageMenu }); }
            } catch (err) {
                await setUserState(chatId, null);
                return bot.sendMessage(chatId, `❌ <b>Error:</b> ${err.message}`, { parse_mode: 'HTML', ...adminMenu });
            }
        }
    }

    // --- MAIN MENUS ---
    if (text === '/start') return bot.sendMessage(chatId, settings.welcome_msg || 'Welcome to the Bot!', { parse_mode: 'HTML', ...currentMenu });
    
    // 1. VIP Fix Number
    if (text === '📱 Fix Number') {
        if (!user.is_approved && !isAdmin) {
            await setUserState(chatId, 'WAITING_SECRET_CODE');
            return bot.sendMessage(chatId, "🔒 <b>VIP Only Area</b>\nPlease enter your secret invite code:", { parse_mode: 'HTML', ...cancelMenu });
        }
        await setUserState(chatId, 'WAITING_NUMBER');
        return bot.sendMessage(chatId, "📞 <b>Enter the number with country code:</b>", { parse_mode: 'HTML', ...cancelMenu });
    }

    // 2. Public Get Number
    if (text === '🔢 Get Number') {
        if(!settings.mauth_api) return bot.sendMessage(chatId, "⚠️ API Key not set by Admin yet.", { parse_mode: 'HTML' });
        const numMenu = { reply_markup: { inline_keyboard: [
            [{ text: '🌐 Auto Country Mode', callback_data: 'getnum_auto' }],
            [{ text: '⚙️ Manual Range', callback_data: 'getnum_manual' }],
            [{ text: '🚦 Live Traffic', callback_data: 'live_traffic' }]
        ]}};
        return bot.sendMessage(chatId, "📞 <b>Select Get Number Mode:</b>", { parse_mode: 'HTML', ...numMenu });
    }

    // 3. Public 2FA
    if (text === '🔐 2FA Generator') {
        await setUserState(chatId, 'WAITING_2FA_SECRET');
        return bot.sendMessage(chatId, "📝 <b>Send Your Secret Key</b>\nExample: <code>JBSWY3DPEHPK3PXP</code>", { parse_mode: 'HTML', ...cancelMenu });
    }

    // 4. User Stats
    if (text === '📊 My Stats') {
        const rate = user.total_numbers > 0 ? Math.round((user.total_otps / user.total_numbers) * 100) : 0;
        const msg = `👤 <b>Your Statistics</b>\n━━━━━━━━━━━━━━━━\n📞 <b>Numbers Taken:</b> ${user.total_numbers}\n📩 <b>OTPs Received:</b> ${user.total_otps}\n📈 <b>Success Rate:</b> ${rate}%`;
        return bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
    }

    if (text === '🎧 Support') return bot.sendMessage(chatId, `👨‍💻 <b>Support System</b>\nFor any issues, contact admin.`, { parse_mode: 'HTML' });

    // --- ADMIN PANELS ---
    if (isAdmin) {
        if (text === '⚙️ Admin Panel') return bot.sendMessage(chatId, "⚙️ <b>Admin Panel</b>", { parse_mode: 'HTML', ...adminMenu });
        if (text === '⚙️ Bot Config') return bot.sendMessage(chatId, "⚙️ <b>Bot Configuration</b>", { parse_mode: 'HTML', ...botConfigMenu });
        if (text === '🌐 API & Email') return bot.sendMessage(chatId, "🌐 <b>API & Email Settings</b>", { parse_mode: 'HTML', ...apiEmailMenu });
        if (text === '👥 User Manage') return bot.sendMessage(chatId, "👥 <b>User Management</b>", { parse_mode: 'HTML', ...userManageMenu });
        
        if (text === '🔌 API Setup') { await setUserState(chatId, 'WAITING_API_KEY'); return bot.sendMessage(chatId, `🔌 Current Key: <code>${settings.mauth_api ? 'Set' : 'None'}</code>\nEnter new mauthapi key:`, { parse_mode: 'HTML', ...cancelMenu }); }
        if (text === '📝 WLC MESSAGE EDIT') { await setUserState(chatId, 'WAITING_WLC'); return bot.sendMessage(chatId, "Send new welcome message:", { ...cancelMenu }); }
        if (text === '📊 LIMIT USER') { await setUserState(chatId, 'WAITING_LIMIT'); return bot.sendMessage(chatId, "Enter new 24h SMS limit per user:", { ...cancelMenu }); }
        if (text === '🔗 Generate Invite') { await setUserState(chatId, 'WAITING_INVITE_COUNT'); return bot.sendMessage(chatId, "How many users can use this code?", { ...cancelMenu }); }
        if (text === '🎯 Set Target Email') { await setUserState(chatId, 'WAITING_TARGET_EMAIL'); return bot.sendMessage(chatId, "Enter new target email:", { ...cancelMenu }); }
        if (text === '📧 SMTP Setup') { await setUserState(chatId, 'WAITING_SMTP_CREDS'); return bot.sendMessage(chatId, "Send Gmail and App Password (2 lines):", { ...cancelMenu }); }
        if (text === '📢 Broadcast') { await setUserState(chatId, 'WAITING_BROADCAST'); return bot.sendMessage(chatId, "Send broadcast message:", { ...cancelMenu }); }
        if (text === '✅ Approve User') { await setUserState(chatId, 'WAITING_APPROVE_ID'); return bot.sendMessage(chatId, "Enter Telegram ID:", { ...cancelMenu }); }
    }
}

// --- Callback Processor ---
async function processCallback(query) {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const data = query.data;
    const settings = await getSettings();
    const headers = { 'mauthapi': settings.mauth_api };

    try {
        // CLOSE MSG
        if (data === 'close_msg') {
            return bot.deleteMessage(chatId, msgId).catch(()=>{});
        }

        // FIX NUMBER SEND EMAIL
        if (data.startsWith('sendmsg_')) {
            const number = data.split('_')[1];
            let { data: user } = await supabase.from('bot_users').select('sms_count').eq('telegram_id', chatId).single();
            await supabase.from('bot_users').update({ sms_count: (user.sms_count || 0) + 1 }).eq('telegram_id', chatId);
            
            await bot.editMessageText(`⏳ <b>Sending Request...</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
            if(settings.smtp_user && settings.smtp_pass && settings.target_email) {
                const tr = nodemailer.createTransport({ service: 'gmail', auth: { user: settings.smtp_user, pass: settings.smtp_pass } });
                await tr.sendMail({ from: settings.smtp_user, to: settings.target_email, subject: 'Fix Request', text: `${number} 1 hour and red problem fix please.` }).catch(()=>{});
            }
            await bot.deleteMessage(chatId, msgId);
            return bot.sendMessage(chatId, `✅ <b>Sent Successfully</b>\n📞 Number: <code>${number}</code>`, { parse_mode: 'HTML' });
        }

        // BROADCAST
        if (data === 'run_bcast' && ADMIN_IDS.includes(Number(chatId))) {
            let { data: au } = await supabase.from('bot_users').select('current_state').eq('telegram_id', chatId).single();
            if (au && au.current_state && au.current_state.startsWith('PENDING_BCAST:')) {
                const bmsg = au.current_state.replace('PENDING_BCAST:', '');
                await setUserState(chatId, null);
                await bot.editMessageText(`⏳ <b>Broadcasting...</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
                const { data: users } = await supabase.from('bot_users').select('telegram_id').eq('is_approved', true);
                let s = 0, f = 0;
                for (const u of users) { try { await bot.sendMessage(u.telegram_id, bmsg, { parse_mode: 'HTML' }); s++; } catch(e){ f++; } }
                return bot.editMessageText(`📢 <b>Broadcast done!</b>\n✅ Success: ${s}\n❌ Failed: ${f}`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
            }
        }

        // LIVE TRAFFIC
        if (data === 'live_traffic') {
            await bot.editMessageText(`⏳ <b>Loading Traffic...</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
            const res = await axios.get(`${API_BASE_URL}/liveaccess`, { headers });
            let msg = `🚦 <b>Live Traffic Update</b>\n━━━━━━━━━━━━━━━━━\n`;
            res.data.data.services.slice(0, 3).forEach(srv => {
                msg += `📱 <b>${srv.sid.toUpperCase()}</b>\n`;
                srv.ranges.slice(0, 4).forEach(r => {
                    const c = getCountryByRange(r);
                    msg += `${c.flag} ${c.name} : <code>${r}</code> (High 🟢)\n`;
                });
                msg += '\n';
            });
            const kb = { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'live_traffic' }], [{ text: '🛑 Close', callback_data: 'close_msg' }]] };
            return bot.editMessageText(msg, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: kb });
        }

        // GET NUMBER: AUTO MODE (Show Countries)
        if (data === 'getnum_auto') {
            await bot.editMessageText(`⏳ <b>Scanning Live Services...</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
            const res = await axios.get(`${API_BASE_URL}/liveaccess`, { headers });
            const tg = res.data.data.services.find(s => s.sid.toLowerCase().includes('telegram') || s.sid.toLowerCase().includes('whatsapp'));
            if(!tg || tg.ranges.length === 0) return bot.editMessageText("❌ No live traffic found.", { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
            
            let btns = [];
            let row = [];
            tg.ranges.slice(0, 10).forEach(r => {
                const c = getCountryByRange(r);
                row.push({ text: `${c.flag} ${c.name}`, callback_data: `req_num_${r.replace('XXX','')}` });
                if(row.length === 2) { btns.push(row); row = []; }
            });
            if(row.length > 0) btns.push(row);
            btns.push([{ text: '🛑 Close', callback_data: 'close_msg' }]);
            
            return bot.editMessageText(`🌍 <b>Select High Traffic Country:</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: btns } });
        }

        // GET NUMBER: MANUAL MODE
        if (data === 'getnum_manual') {
            await setUserState(chatId, 'WAITING_MANUAL_RANGE');
            await bot.deleteMessage(chatId, msgId);
            return bot.sendMessage(chatId, "⚙️ <b>Send the Range Prefix</b>\nExample: <code>26134</code>", { parse_mode: 'HTML', reply_markup: { keyboard: [['❌ Cancel']], resize_keyboard: true } });
        }

        // REQUEST NUMBER API CALL
        if (data.startsWith('req_num_')) {
            const range = data.replace('req_num_', '');
            await bot.editMessageText(`⏳ <b>Allocating Number from ${range}...</b>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
            
            const res = await axios.post(`${API_BASE_URL}/getnum`, { rid: range }, { headers });
            if (res.data.meta.code !== 200) {
                return bot.editMessageText(`❌ <b>Out of Stock for range ${range}.</b>\nTry another country.`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🛑 Close', callback_data: 'close_msg' }]]} });
            }
            
            const numData = res.data.data;
            const fullNum = numData.full_number;
            const countryStr = numData.country || 'Global';
            
            // Update User Stats (Number Taken)
            let { data: userStats } = await supabase.from('bot_users').select('total_numbers').eq('telegram_id', chatId).single();
            await supabase.from('bot_users').update({ total_numbers: (userStats.total_numbers || 0) + 1 }).eq('telegram_id', chatId);

            const msg = `🌐 <b>SERVICE ACQUIRED</b>\n━━━━━━━━━━━━━━━━\n🌍 <b>Country:</b> ${countryStr}\n📞 <b>Number:</b> <code>${fullNum}</code>\n\n<i>Click below to get OTP.</i>`;
            
            const kb = { inline_keyboard: [
                [{ text: '📩 Get OTP (Auto Fetch)', callback_data: `chk_otp_${fullNum}` }],
                [{ text: '🔄 Change Number', callback_data: `req_num_${range}` }, { text: '⚙️ Change Range', callback_data: 'getnum_manual' }],
                [{ text: '🛑 Close', callback_data: 'close_msg' }]
            ]};
            
            return bot.editMessageText(msg, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: kb });
        }

        // AUTO OTP FETCHER (Smart Loop)
        if (data.startsWith('chk_otp_')) {
            const targetNum = data.replace('chk_otp_', '');
            await bot.editMessageText(`⏳ <b>Auto Fetching OTP for <code>${targetNum}</code>...</b>\n<i>(Please wait up to 15 seconds)</i>`, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' });
            
            let otpFound = null;
            // Loop 3 times (Total ~15s limit for Vercel safety)
            for(let i=0; i<3; i++) {
                await new Promise(r => setTimeout(r, 4500)); // wait 4.5s
                try {
                    const res = await axios.get(`${API_BASE_URL}/success-otp`, { headers });
                    if(res.data.data && res.data.data.otps) {
                        const myOtp = res.data.data.otps.find(o => o.number.includes(targetNum.replace('+','')));
                        if(myOtp) { otpFound = myOtp; break; }
                    }
                } catch(e) {}
            }

            if (otpFound) {
                // Update User Stats (OTP Received)
                let { data: userStats } = await supabase.from('bot_users').select('total_otps').eq('telegram_id', chatId).single();
                await supabase.from('bot_users').update({ total_otps: (userStats.total_otps || 0) + 1 }).eq('telegram_id', chatId);

                const smsg = `✅ <b>OTP RECEIVED!</b>\n━━━━━━━━━━━━━━━━\n📞 <b>Number:</b> <code>${targetNum}</code>\n💬 <b>Message:</b> <code>${otpFound.message}</code>`;
                return bot.editMessageText(smsg, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🛑 Close', callback_data: 'close_msg' }]]} });
            } else {
                const fmsg = `⏳ <b>OTP Not Received Yet.</b>\n📞 Number: <code>${targetNum}</code>\n\n<i>Click below to check again.</i>`;
                const kb = { inline_keyboard: [
                    [{ text: '🔄 Check Again', callback_data: `chk_otp_${targetNum}` }],
                    [{ text: '🛑 Close', callback_data: 'close_msg' }]
                ]};
                return bot.editMessageText(fmsg, { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: kb });
            }
        }

    } catch (err) {
        console.log("Callback Error: ", err.message);
    }
}

// --- Webhook Export ---
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
