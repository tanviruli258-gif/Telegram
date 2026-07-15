// ============================================================================
// TELEGRAM ADMIN BOT — Production Entry Point
// Runtime: Node.js (ES Modules) — Deployable as a Vercel Serverless Function
// ============================================================================

import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import crypto from 'crypto';

// ----------------------------------------------------------------------------
// CONFIGURATION — the only values that need to be replaced for deployment.
// ----------------------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => Number(id));
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const TARGET_EMAIL = process.env.TARGET_EMAIL;

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_SECRET_KEY || !TARGET_EMAIL || ADMIN_IDS.length === 0) {
    console.error('FATAL: Missing required configuration. Check BOT_TOKEN, ADMIN_IDS, SUPABASE_URL, SUPABASE_SECRET_KEY, TARGET_EMAIL.');
}

// ----------------------------------------------------------------------------
// CLIENTS
// ----------------------------------------------------------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
});

const bot = new TelegramBot(BOT_TOKEN);

let cachedBotUsername = null;
async function getBotUsername() {
    if (cachedBotUsername) return cachedBotUsername;
    const me = await bot.getMe();
    cachedBotUsername = me.username;
    return cachedBotUsername;
}

// ----------------------------------------------------------------------------
// BUTTON LABELS
// ----------------------------------------------------------------------------
const BTN_PRODUCT_ORDER = '🛒 Product Order';
const BTN_SUPPORT = '🎧 Support';
const BTN_ADMIN_PANEL = '⚙️ Admin Panel';
const BTN_BACK = '🔙 Back';

const BTN_WELCOME_EDIT = '📝 WLC MESSAGE EDIT';
const BTN_BOT_TOGGLE = '⚙️ BOT ON/OFF';
const BTN_SET_EMAIL_API = '🔑 SET EMAIL API';
const BTN_LIMIT_USER = '📊 LIMIT USER';
const BTN_BROADCAST = '📢 Broadcast';
const BTN_USERS = '👥 Users';
const BTN_STATISTICS = '📈 Statistics';
const BTN_BAN_USER = '🚫 Ban User';
const BTN_APPROVE_USER = '✅ Approve User';
const BTN_REMOVE_USER = '❌ Remove User';
const BTN_CLEAR_DB = '🗑 Clear Database';
const BTN_SETTINGS = '⚙ Settings';

const BTN_TOGGLE_APPROVAL = '🔄 Toggle Approval Mode';
const BTN_SET_COOLDOWN = '⏱ Set Cooldown Minutes';
const BTN_SET_SUPPORT_EMAIL = '📧 Set Support Email';
const BTN_GENERATE_INVITE = '🎟 Generate Invite Code';

const BTN_SEND_BROADCAST = '📩 Send Message';
const BTN_CANCEL = '❌ Cancel';

// ----------------------------------------------------------------------------
// KEYBOARDS (Reply Keyboards only — no inline keyboards anywhere)
// ----------------------------------------------------------------------------
function mainMenuKeyboard(isAdminUser) {
    const rows = [[BTN_PRODUCT_ORDER, BTN_SUPPORT]];
    if (isAdminUser) rows.push([BTN_ADMIN_PANEL]);
    return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

function adminPanelKeyboard() {
    return {
        keyboard: [
            [BTN_WELCOME_EDIT, BTN_BOT_TOGGLE],
            [BTN_SET_EMAIL_API, BTN_LIMIT_USER],
            [BTN_BROADCAST, BTN_USERS],
            [BTN_STATISTICS, BTN_SETTINGS],
            [BTN_BAN_USER, BTN_APPROVE_USER],
            [BTN_REMOVE_USER, BTN_CLEAR_DB],
            [BTN_BACK],
        ],
        resize_keyboard: true,
        is_persistent: true,
    };
}

function settingsMenuKeyboard() {
    return {
        keyboard: [
            [BTN_TOGGLE_APPROVAL],
            [BTN_SET_COOLDOWN, BTN_SET_SUPPORT_EMAIL],
            [BTN_GENERATE_INVITE],
            [BTN_BACK],
        ],
        resize_keyboard: true,
        is_persistent: true,
    };
}

function broadcastConfirmKeyboard() {
    return {
        keyboard: [[BTN_SEND_BROADCAST], [BTN_CANCEL]],
        resize_keyboard: true,
        is_persistent: true,
    };
}

function backOnlyKeyboard() {
    return { keyboard: [[BTN_BACK]], resize_keyboard: true, is_persistent: true };
}

// ----------------------------------------------------------------------------
// DATA HELPERS
// ----------------------------------------------------------------------------
function isAdmin(telegramId) {
    return ADMIN_IDS.includes(Number(telegramId));
}

async function getSettings() {
    const { data, error } = await supabase.from('settings').select('*').eq('id', 1).single();
    if (error) {
        console.error('getSettings error:', error.message);
        throw error;
    }
    return data;
}

async function updateSettings(patch) {
    const { data, error } = await supabase.from('settings').update(patch).eq('id', 1).select().single();
    if (error) {
        console.error('updateSettings error:', error.message);
        throw error;
    }
    return data;
}

async function getUser(telegramId) {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('telegram_id', telegramId)
        .maybeSingle();
    if (error) {
        console.error('getUser error:', error.message);
        throw error;
    }
    return data;
}

async function getUserState(telegramId) {
    const { data, error } = await supabase
        .from('user_states')
        .select('*')
        .eq('telegram_id', telegramId)
        .maybeSingle();
    if (error) {
        console.error('getUserState error:', error.message);
        throw error;
    }
    return data;
}

async function setUserState(telegramId, state, data = {}) {
    const { error } = await supabase
        .from('user_states')
        .upsert({ telegram_id: telegramId, state, data, updated_at: new Date().toISOString() });
    if (error) console.error('setUserState error:', error.message);
}

async function clearUserState(telegramId) {
    const { error } = await supabase.from('user_states').delete().eq('telegram_id', telegramId);
    if (error) console.error('clearUserState error:', error.message);
}

async function logAction(actionType, actorId, targetId, details = {}) {
    const { error } = await supabase.from('logs').insert({
        action_type: actionType,
        actor_id: actorId ?? null,
        target_id: targetId ?? null,
        details,
    });
    if (error) console.error('logAction error:', error.message);
}

function isValidTelegramId(str) {
    return /^\d{5,15}$/.test(str);
}

function isValidEmail(str) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str);
}

function parsePositiveInt(str) {
    const n = Number(str);
    return Number.isInteger(n) && n > 0 ? n : null;
}

function generateInviteCode() {
    return crypto.randomBytes(6).toString('hex').toUpperCase();
}

async function safeSendMessage(chatId, text, options = {}) {
    try {
        return await bot.sendMessage(chatId, text, options);
    } catch (err) {
        console.error(`safeSendMessage failed for ${chatId}:`, err.message);
        return null;
    }
}

// ----------------------------------------------------------------------------
// EMAIL DELIVERY
// ----------------------------------------------------------------------------
async function sendTransactionalEmail(subject, html) {
    const settings = await getSettings();
    if (!settings.email_api_key) {
        throw new Error('EMAIL_API_NOT_CONFIGURED');
    }

    const response = await axios.post(
        settings.email_api_url,
        {
            from: settings.email_from_address,
            to: [TARGET_EMAIL],
            subject,
            html,
        },
        {
            headers: {
                Authorization: `Bearer ${settings.email_api_key}`,
                'Content-Type': 'application/json',
            },
            timeout: 15000,
        }
    );

    return response.data;
}

// ----------------------------------------------------------------------------
// MENU NAVIGATION
// ----------------------------------------------------------------------------
async function showMainMenu(chatId, telegramId) {
    await setUserState(telegramId, 'menu_main', {});
    const settings = await getSettings();
    await safeSendMessage(chatId, settings.welcome_message, {
        parse_mode: 'Markdown',
        reply_markup: mainMenuKeyboard(isAdmin(telegramId)),
    });
}

async function showAdminMenu(chatId, telegramId) {
    await setUserState(telegramId, 'menu_admin', {});
    await safeSendMessage(chatId, '⚙️ *Admin Panel*\nChoose an action below.', {
        parse_mode: 'Markdown',
        reply_markup: adminPanelKeyboard(),
    });
}

async function showSettingsMenu(chatId, telegramId) {
    await setUserState(telegramId, 'menu_settings', {});
    const settings = await getSettings();
    const text =
        `⚙ *Settings*\n\n` +
        `Approval Mode: ${settings.approval_required ? 'ON ✅' : 'OFF ❌'}\n` +
        `Cooldown Minutes: ${settings.cooldown_minutes}\n` +
        `Support Email: ${settings.support_email}`;
    await safeSendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: settingsMenuKeyboard() });
}

async function promptInput(chatId, telegramId, inputState, returnTo, promptText, extraData = {}) {
    await setUserState(telegramId, inputState, { returnTo, ...extraData });
    await safeSendMessage(chatId, promptText, { parse_mode: 'Markdown', reply_markup: backOnlyKeyboard() });
}

async function returnToMenu(chatId, telegramId, returnTo) {
    if (returnTo === 'admin') return showAdminMenu(chatId, telegramId);
    if (returnTo === 'settings') return showSettingsMenu(chatId, telegramId);
    return showMainMenu(chatId, telegramId);
}

// ----------------------------------------------------------------------------
// /start HANDLER
// ----------------------------------------------------------------------------
async function handleStart(msg) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const parts = (msg.text || '').trim().split(/\s+/);
    const invitePayload = parts.length > 1 ? parts[1] : null;
    const admin = isAdmin(telegramId);

    const settings = await getSettings();
    const existingUser = await getUser(telegramId);

    if (existingUser) {
        await clearUserState(telegramId);
        if (existingUser.is_banned) {
            await safeSendMessage(chatId, '🚫 You have been banned from using this bot.');
            return;
        }
        if (!settings.bot_enabled && !admin) {
            await safeSendMessage(chatId, '🛠 The bot is currently under maintenance. Please try again later.');
            return;
        }
        if (settings.approval_required && !existingUser.is_approved && !admin) {
            await safeSendMessage(chatId, '⏳ Your account is pending admin approval. Please wait.');
            return;
        }
        await showMainMenu(chatId, telegramId);
        return;
    }

    // New user registration flow
    if (!admin) {
        if (!settings.bot_enabled) {
            await safeSendMessage(chatId, '🛠 The bot is currently under maintenance. Please try again later.');
            return;
        }

        if (!invitePayload) {
            await safeSendMessage(chatId, '🔒 You need a valid invite link to join this bot. Please contact the admin.');
            return;
        }

        const { data: claimedInvite, error: claimError } = await supabase.rpc('claim_invite', {
            p_code: invitePayload,
        });
        if (claimError) {
            console.error('claim_invite error:', claimError.message);
            await safeSendMessage(chatId, '⚠️ Something went wrong validating your invite. Please try again later.');
            return;
        }
        if (!claimedInvite) {
            await safeSendMessage(chatId, '❌ This invite link is invalid or has already reached its usage limit.');
            return;
        }

        const { count: userCount } = await supabase.from('users').select('*', { count: 'exact', head: true });
        if ((userCount ?? 0) >= settings.max_users) {
            await safeSendMessage(chatId, '🚫 User limit reached. The bot is not accepting new users right now.');
            return;
        }

        await supabase.from('invite_uses').insert({ invite_id: claimedInvite.id, telegram_id: telegramId });
    }

    const isApproved = admin || !settings.approval_required;
    const { error: insertError } = await supabase.from('users').insert({
        telegram_id: telegramId,
        username: msg.from.username || null,
        first_name: msg.from.first_name || null,
        last_name: msg.from.last_name || null,
        invite_code_used: invitePayload,
        is_approved: isApproved,
    });

    if (insertError) {
        // Duplicate registration race-condition guard (unique constraint on telegram_id)
        if (insertError.code === '23505') {
            await showMainMenu(chatId, telegramId);
            return;
        }
        console.error('user insert error:', insertError.message);
        await safeSendMessage(chatId, '⚠️ Registration failed. Please try again.');
        return;
    }

    await logAction('user_registered', telegramId, telegramId, { invite: invitePayload || null });

    if (!isApproved) {
        await safeSendMessage(chatId, '⏳ Thanks for joining! Please wait for admin approval before you can use the bot.');
        const adminText =
            `🆕 *New user pending approval*\n\n` +
            `Telegram ID: \`${telegramId}\`\n` +
            `Username: ${msg.from.username ? '@' + msg.from.username : 'N/A'}\n` +
            `Name: ${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() +
            `\n\nUse ✅ Approve User in the Admin Panel with this ID to approve.`;
        for (const adminId of ADMIN_IDS) {
            await safeSendMessage(adminId, adminText, { parse_mode: 'Markdown' });
        }
        return;
    }

    await showMainMenu(chatId, telegramId);
}

// ----------------------------------------------------------------------------
// PRODUCT ORDER FEATURE
// ----------------------------------------------------------------------------
async function beginProductOrder(chatId, telegramId) {
    await promptInput(
        chatId,
        telegramId,
        'input_product_order',
        'main',
        '🛒 Please type the *product name* you purchased and we will send a confirmation.'
    );
}

async function completeProductOrder(msg, telegramId, productName) {
    const chatId = msg.chat.id;
    const subject = 'Product Purchase Confirmation';
    const html =
        `<p>Thank you for purchasing our product: <strong>${escapeHtml(productName)}</strong>.</p>` +
        `<p>We appreciate your trust in us!</p>` +
        `<p><small>Telegram user ID: ${telegramId}</small></p>`;

    let sent = false;
    try {
        await sendTransactionalEmail(subject, html);
        sent = true;
    } catch (err) {
        console.error('completeProductOrder email error:', err.message);
    }

    await supabase.from('product_orders').insert({
        telegram_id: telegramId,
        product_name: productName,
        email_sent: sent,
    });

    await logAction('product_order_email', telegramId, telegramId, { product_name: productName, sent });

    if (sent) {
        await safeSendMessage(chatId, '✅ Thank you! A confirmation has been sent.');
    } else {
        await safeSendMessage(
            chatId,
            '⚠️ We could not send the confirmation email right now. Our team has been notified — please contact support.'
        );
    }

    await returnToMenu(chatId, telegramId, 'main');
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ----------------------------------------------------------------------------
// ADMIN ACTIONS
// ----------------------------------------------------------------------------
async function handleWelcomeEditPrompt(chatId, telegramId) {
    const settings = await getSettings();
    await promptInput(
        chatId,
        telegramId,
        'input_welcome',
        'admin',
        `📝 Current welcome message:\n\n${settings.welcome_message}\n\nSend the new welcome message (Markdown & emoji supported).`
    );
}

async function handleBotTogglePress(chatId, telegramId) {
    const settings = await getSettings();
    const updated = await updateSettings({ bot_enabled: !settings.bot_enabled });
    await logAction('bot_toggle', telegramId, null, { bot_enabled: updated.bot_enabled });
    await safeSendMessage(chatId, `⚙️ Bot is now *${updated.bot_enabled ? 'ONLINE ✅' : 'OFFLINE 🛑'}*.`, {
        parse_mode: 'Markdown',
    });
    await showAdminMenu(chatId, telegramId);
}

async function handleSetEmailApiPrompt(chatId, telegramId) {
    await promptInput(
        chatId,
        telegramId,
        'input_email_api',
        'admin',
        '🔑 Send your email API key.\n\nTo also change the API endpoint URL, send it as:\n`URL|API_KEY`'
    );
}

async function handleLimitUserPrompt(chatId, telegramId) {
    const settings = await getSettings();
    await promptInput(
        chatId,
        telegramId,
        'input_limit_daily',
        'admin',
        `📊 Current daily message limit: *${settings.daily_message_limit}*\n\nSend the new daily message limit (number), or send \`skip\` to keep it unchanged.`
    );
}

async function handleBroadcastPrompt(chatId, telegramId) {
    await promptInput(
        chatId,
        telegramId,
        'input_broadcast_message',
        'admin',
        '📢 Send the message you want to broadcast to all approved users (Markdown supported).'
    );
}

async function handleUsersList(chatId, telegramId) {
    const { data: users, error } = await supabase
        .from('users')
        .select('telegram_id, username, is_approved, is_banned, joined_at')
        .order('joined_at', { ascending: false })
        .limit(30);

    if (error) {
        console.error('handleUsersList error:', error.message);
        await safeSendMessage(chatId, '⚠️ Failed to load users.');
        await showAdminMenu(chatId, telegramId);
        return;
    }

    const { count: totalCount } = await supabase.from('users').select('*', { count: 'exact', head: true });

    if (!users || users.length === 0) {
        await safeSendMessage(chatId, '👥 No users registered yet.');
        await showAdminMenu(chatId, telegramId);
        return;
    }

    let text = `👥 *Users* (showing latest ${users.length} of ${totalCount})\n\n`;
    for (const u of users) {
        const status = u.is_banned ? '🚫' : u.is_approved ? '✅' : '⏳';
        const uname = u.username ? '@' + u.username : 'N/A';
        text += `${status} \`${u.telegram_id}\` — ${uname}\n`;
    }

    await safeSendMessage(chatId, text, { parse_mode: 'Markdown' });
    await showAdminMenu(chatId, telegramId);
}

async function handleStatistics(chatId, telegramId) {
    const { data, error } = await supabase.from('v_bot_statistics').select('*').single();
    if (error) {
        console.error('handleStatistics error:', error.message);
        await safeSendMessage(chatId, '⚠️ Failed to load statistics.');
        await showAdminMenu(chatId, telegramId);
        return;
    }

    const text =
        `📈 *Bot Statistics*\n\n` +
        `👥 Total Users: ${data.total_users}\n` +
        `✅ Approved Users: ${data.approved_users}\n` +
        `⏳ Pending Users: ${data.pending_users}\n` +
        `🚫 Banned Users: ${data.banned_users}\n` +
        `🆕 Today's Users: ${data.todays_users}\n` +
        `💬 Total Messages: ${data.total_messages}\n` +
        `🧊 Cooldown Users: ${data.cooldown_users}\n` +
        `🎟 Active Invites: ${data.active_invites}\n` +
        `📊 Total Invite Uses: ${data.total_invite_uses}\n` +
        `📢 Total Broadcasts: ${data.total_broadcasts}\n` +
        `🛒 Product Orders: ${data.total_product_orders}`;

    await safeSendMessage(chatId, text, { parse_mode: 'Markdown' });
    await showAdminMenu(chatId, telegramId);
}

async function handleBanUserPrompt(chatId, telegramId) {
    await promptInput(chatId, telegramId, 'input_ban_id', 'admin', '🚫 Send the Telegram ID of the user to ban.');
}

async function handleApproveUserPrompt(chatId, telegramId) {
    await promptInput(chatId, telegramId, 'input_approve_id', 'admin', '✅ Send the Telegram ID of the user to approve.');
}

async function handleRemoveUserPrompt(chatId, telegramId) {
    await promptInput(
        chatId,
        telegramId,
        'input_remove_id',
        'admin',
        '❌ Send the Telegram ID of the user to permanently remove.'
    );
}

async function handleClearDatabasePrompt(chatId, telegramId) {
    await promptInput(
        chatId,
        telegramId,
        'input_clear_confirm',
        'admin',
        '🗑 *This will permanently delete ALL users, invites, logs, broadcasts and orders.*\n\nThis action cannot be undone.\n\nSend `CONFIRM DELETE` to proceed, or press Back to cancel.'
    );
}

async function handleSettingsButton(chatId, telegramId) {
    await showSettingsMenu(chatId, telegramId);
}

async function handleToggleApproval(chatId, telegramId) {
    const settings = await getSettings();
    const updated = await updateSettings({ approval_required: !settings.approval_required });
    await logAction('approval_toggle', telegramId, null, { approval_required: updated.approval_required });
    await safeSendMessage(chatId, `🔄 Approval mode is now *${updated.approval_required ? 'ON' : 'OFF'}*.`, {
        parse_mode: 'Markdown',
    });
    await showSettingsMenu(chatId, telegramId);
}

async function handleSetCooldownPrompt(chatId, telegramId) {
    const settings = await getSettings();
    await promptInput(
        chatId,
        telegramId,
        'input_cooldown',
        'settings',
        `⏱ Current cooldown: *${settings.cooldown_minutes} minute(s)*\n\nSend the new cooldown duration in minutes.`
    );
}

async function handleSetSupportEmailPrompt(chatId, telegramId) {
    const settings = await getSettings();
    await promptInput(
        chatId,
        telegramId,
        'input_support_email',
        'settings',
        `📧 Current support email: *${settings.support_email}*\n\nSend the new support email address.`
    );
}

async function handleGenerateInvitePrompt(chatId, telegramId) {
    await promptInput(
        chatId,
        telegramId,
        'input_invite_maxuses',
        'settings',
        '🎟 Send the maximum number of users this invite code can register (e.g. `5`).'
    );
}

// ----------------------------------------------------------------------------
// BROADCAST EXECUTION
// ----------------------------------------------------------------------------
async function executeBroadcast(chatId, telegramId, message) {
    const processingMsg = await safeSendMessage(chatId, '⏳ Processing...');

    const { data: recipients, error } = await supabase
        .from('users')
        .select('telegram_id')
        .eq('is_approved', true)
        .eq('is_banned', false);

    if (error) {
        console.error('executeBroadcast fetch error:', error.message);
        await safeSendMessage(chatId, '⚠️ Failed to load recipients.');
        await showAdminMenu(chatId, telegramId);
        return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const recipient of recipients) {
        try {
            await bot.sendMessage(recipient.telegram_id, message, { parse_mode: 'Markdown' });
            successCount += 1;
        } catch (err) {
            failCount += 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
    }

    if (processingMsg) {
        try {
            await bot.deleteMessage(chatId, processingMsg.message_id);
        } catch (err) {
            // Message may already be gone; ignore.
        }
    }

    await supabase.from('broadcasts').insert({
        sent_by: telegramId,
        message,
        success_count: successCount,
        fail_count: failCount,
    });

    await logAction('broadcast_sent', telegramId, null, { success: successCount, fail: failCount });

    await safeSendMessage(
        chatId,
        `✅ Broadcast completed successfully.\n\n📬 Success: ${successCount}\n❌ Failed: ${failCount}`
    );
    await showAdminMenu(chatId, telegramId);
}

// ----------------------------------------------------------------------------
// STATE INPUT ROUTER — handles free-text replies to admin/user prompts
// ----------------------------------------------------------------------------
async function handleStateInput(msg, state) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const text = (msg.text || '').trim();
    const returnTo = state.data?.returnTo || 'main';

    switch (state.state) {
        case 'menu_main':
        case 'menu_admin':
        case 'menu_settings':
            // Pure navigation states are handled by the main dispatcher, not here.
            await dispatchMenuButton(msg, text);
            return;

        case 'input_product_order': {
            if (!text) {
                await safeSendMessage(chatId, '⚠️ Please type a valid product name.');
                return;
            }
            await completeProductOrder(msg, telegramId, text);
            return;
        }

        case 'input_welcome': {
            await updateSettings({ welcome_message: text });
            await logAction('welcome_message_updated', telegramId, null, {});
            await safeSendMessage(chatId, '✅ Welcome message updated.');
            await returnToMenu(chatId, telegramId, returnTo);
            return;
        }

        case 'input_email_api': {
            let apiUrl;
            let apiKey;
            if (text.includes('|')) {
                const [urlPart, keyPart] = text.split('|').map((s) => s.trim());
                apiUrl = urlPart;
                apiKey = keyPart;
            } else {
                apiKey = text;
            }
            const patch = { email_api_key: apiKey };
            if (apiUrl) patch.email_api_url = apiUrl;
            await updateSettings(patch);
            await logAction('email_api_updated', telegramId, null, { masked_key: apiKey.slice(0, 4) + '****' });
            await safeSendMessage(chatId, '✅ Email API configuration updated.');
            await returnToMenu(chatId, telegramId, returnTo);
            return;
        }

        case 'input_limit_daily': {
            if (text.toLowerCase() !== 'skip') {
                const value = parsePositiveInt(text);
                if (!value) {
                    await safeSendMessage(chatId, '⚠️ Please send a valid positive number, or `skip`.');
                    return;
                }
                await updateSettings({ daily_message_limit: value });
            }
            const settings = await getSettings();
            await promptInput(
                chatId,
                telegramId,
                'input_limit_maxusers',
                'admin',
                `📊 Current max users: *${settings.max_users}*\n\nSend the new max users limit (number), or send \`skip\` to keep it unchanged.`
            );
            return;
        }

        case 'input_limit_maxusers': {
            if (text.toLowerCase() !== 'skip') {
                const value = parsePositiveInt(text);
                if (!value) {
                    await safeSendMessage(chatId, '⚠️ Please send a valid positive number, or `skip`.');
                    return;
                }
                await updateSettings({ max_users: value });
            }
            await logAction('user_limits_updated', telegramId, null, {});
            const settings = await getSettings();
            await safeSendMessage(
                chatId,
                `✅ Limits updated.\n\nDaily message limit: ${settings.daily_message_limit}\nMax users: ${settings.max_users}`
            );
            await returnToMenu(chatId, telegramId, 'admin');
            return;
        }

        case 'input_broadcast_message': {
            if (!text) {
                await safeSendMessage(chatId, '⚠️ Please send a valid message to broadcast.');
                return;
            }
            await setUserState(telegramId, 'input_broadcast_confirm', { returnTo: 'admin', message: text });
            await safeSendMessage(chatId, `📢 *Preview:*\n\n${text}\n\nSend to confirm, or cancel.`, {
                parse_mode: 'Markdown',
                reply_markup: broadcastConfirmKeyboard(),
            });
            return;
        }

        case 'input_broadcast_confirm': {
            if (text === BTN_SEND_BROADCAST) {
                const message = state.data.message;
                await clearUserState(telegramId);
                await executeBroadcast(chatId, telegramId, message);
                return;
            }
            if (text === BTN_CANCEL) {
                await safeSendMessage(chatId, '❌ Broadcast cancelled.');
                await returnToMenu(chatId, telegramId, 'admin');
                return;
            }
            await safeSendMessage(chatId, `Please press "${BTN_SEND_BROADCAST}" or "${BTN_CANCEL}".`, {
                reply_markup: broadcastConfirmKeyboard(),
            });
            return;
        }

        case 'input_ban_id': {
            if (!isValidTelegramId(text)) {
                await safeSendMessage(chatId, '⚠️ Please send a valid numeric Telegram ID.');
                return;
            }
            const targetId = Number(text);
            const targetUser = await getUser(targetId);
            if (!targetUser) {
                await safeSendMessage(chatId, '❌ No user found with that Telegram ID.');
                return;
            }
            await supabase.from('users').update({ is_banned: true }).eq('telegram_id', targetId);
            await logAction('user_banned', telegramId, targetId, {});
            await safeSendMessage(chatId, `🚫 User \`${targetId}\` has been banned.`, { parse_mode: 'Markdown' });
            await safeSendMessage(targetId, '🚫 You have been banned from using this bot.');
            await returnToMenu(chatId, telegramId, 'admin');
            return;
        }

        case 'input_approve_id': {
            if (!isValidTelegramId(text)) {
                await safeSendMessage(chatId, '⚠️ Please send a valid numeric Telegram ID.');
                return;
            }
            const targetId = Number(text);
            const targetUser = await getUser(targetId);
            if (!targetUser) {
                await safeSendMessage(chatId, '❌ No user found with that Telegram ID.');
                return;
            }
            await supabase.from('users').update({ is_approved: true }).eq('telegram_id', targetId);
            await logAction('user_approved', telegramId, targetId, {});
            await safeSendMessage(chatId, `✅ User \`${targetId}\` has been approved.`, { parse_mode: 'Markdown' });
            await safeSendMessage(targetId, '✅ You have been approved! You can now use the bot.', {
                reply_markup: mainMenuKeyboard(false),
            });
            await returnToMenu(chatId, telegramId, 'admin');
            return;
        }

        case 'input_remove_id': {
            if (!isValidTelegramId(text)) {
                await safeSendMessage(chatId, '⚠️ Please send a valid numeric Telegram ID.');
                return;
            }
            const targetId = Number(text);
            const targetUser = await getUser(targetId);
            if (!targetUser) {
                await safeSendMessage(chatId, '❌ No user found with that Telegram ID.');
                return;
            }
            await safeSendMessage(targetId, '❌ Your account has been removed by an administrator.');
            await supabase.from('users').delete().eq('telegram_id', targetId);
            await supabase.from('user_states').delete().eq('telegram_id', targetId);
            await logAction('user_removed', telegramId, targetId, {});
            await safeSendMessage(chatId, `❌ User \`${targetId}\` has been removed.`, { parse_mode: 'Markdown' });
            await returnToMenu(chatId, telegramId, 'admin');
            return;
        }

        case 'input_clear_confirm': {
            if (text === 'CONFIRM DELETE') {
                const { error } = await supabase.rpc('clear_all_data');
                if (error) {
                    console.error('clear_all_data error:', error.message);
                    await safeSendMessage(chatId, '⚠️ Failed to clear the database.');
                } else {
                    await logAction('database_cleared', telegramId, null, {});
                    await safeSendMessage(chatId, '🗑 Database cleared successfully.');
                }
            } else {
                await safeSendMessage(chatId, '❌ Cancelled — database was not modified.');
            }
            await returnToMenu(chatId, telegramId, 'admin');
            return;
        }

        case 'input_cooldown': {
            const value = parsePositiveInt(text);
            if (!value) {
                await safeSendMessage(chatId, '⚠️ Please send a valid positive number of minutes.');
                return;
            }
            await updateSettings({ cooldown_minutes: value });
            await logAction('cooldown_updated', telegramId, null, { minutes: value });
            await safeSendMessage(chatId, `✅ Cooldown set to ${value} minute(s).`);
            await returnToMenu(chatId, telegramId, 'settings');
            return;
        }

        case 'input_support_email': {
            if (!isValidEmail(text)) {
                await safeSendMessage(chatId, '⚠️ Please send a valid email address.');
                return;
            }
            await updateSettings({ support_email: text });
            await logAction('support_email_updated', telegramId, null, { email: text });
            await safeSendMessage(chatId, '✅ Support email updated.');
            await returnToMenu(chatId, telegramId, 'settings');
            return;
        }

        case 'input_invite_maxuses': {
            const value = parsePositiveInt(text);
            if (!value || value > 1000) {
                await safeSendMessage(chatId, '⚠️ Please send a valid number between 1 and 1000.');
                return;
            }
            const code = generateInviteCode();
            await supabase.from('invites').insert({ code, created_by: telegramId, max_uses: value });
            await logAction('invite_generated', telegramId, null, { code, max_uses: value });
            const username = await getBotUsername();
            await safeSendMessage(
                chatId,
                `🎟 Invite code generated!\n\nCode: \`${code}\`\nMax uses: ${value}\n\nLink:\nhttps://t.me/${username}?start=${code}`,
                { parse_mode: 'Markdown' }
            );
            await returnToMenu(chatId, telegramId, 'settings');
            return;
        }

        default: {
            await clearUserState(telegramId);
            await showMainMenu(chatId, telegramId);
        }
    }
}

// ----------------------------------------------------------------------------
// MENU BUTTON DISPATCH
// ----------------------------------------------------------------------------
async function dispatchMenuButton(msg, text) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const admin = isAdmin(telegramId);

    switch (text) {
        case BTN_PRODUCT_ORDER:
            await beginProductOrder(chatId, telegramId);
            return;

        case BTN_SUPPORT: {
            const settings = await getSettings();
            await safeSendMessage(chatId, `${settings.support_message}\n\n📧 ${settings.support_email}`, {
                parse_mode: 'Markdown',
            });
            return;
        }

        case BTN_ADMIN_PANEL:
            if (admin) {
                await showAdminMenu(chatId, telegramId);
            } else {
                await safeSendMessage(chatId, '🚫 You are not authorized to access this section.');
            }
            return;

        case BTN_BACK: {
            const state = await getUserState(telegramId);
            if (!state) {
                await showMainMenu(chatId, telegramId);
                return;
            }
            if (state.state === 'menu_admin') {
                await showMainMenu(chatId, telegramId);
                return;
            }
            if (state.state === 'menu_settings') {
                await showAdminMenu(chatId, telegramId);
                return;
            }
            if (state.state === 'menu_main') {
                await showMainMenu(chatId, telegramId);
                return;
            }
            const returnTo = state.data?.returnTo || 'main';
            await returnToMenu(chatId, telegramId, returnTo);
            return;
        }
    }

    if (!admin) {
        await safeSendMessage(chatId, '❓ Please use the menu buttons below.');
        await showMainMenu(chatId, telegramId);
        return;
    }

    switch (text) {
        case BTN_WELCOME_EDIT:
            await handleWelcomeEditPrompt(chatId, telegramId);
            return;
        case BTN_BOT_TOGGLE:
            await handleBotTogglePress(chatId, telegramId);
            return;
        case BTN_SET_EMAIL_API:
            await handleSetEmailApiPrompt(chatId, telegramId);
            return;
        case BTN_LIMIT_USER:
            await handleLimitUserPrompt(chatId, telegramId);
            return;
        case BTN_BROADCAST:
            await handleBroadcastPrompt(chatId, telegramId);
            return;
        case BTN_USERS:
            await handleUsersList(chatId, telegramId);
            return;
        case BTN_STATISTICS:
            await handleStatistics(chatId, telegramId);
            return;
        case BTN_BAN_USER:
            await handleBanUserPrompt(chatId, telegramId);
            return;
        case BTN_APPROVE_USER:
            await handleApproveUserPrompt(chatId, telegramId);
            return;
        case BTN_REMOVE_USER:
            await handleRemoveUserPrompt(chatId, telegramId);
            return;
        case BTN_CLEAR_DB:
            await handleClearDatabasePrompt(chatId, telegramId);
            return;
        case BTN_SETTINGS:
            await handleSettingsButton(chatId, telegramId);
            return;
        case BTN_TOGGLE_APPROVAL:
            await handleToggleApproval(chatId, telegramId);
            return;
        case BTN_SET_COOLDOWN:
            await handleSetCooldownPrompt(chatId, telegramId);
            return;
        case BTN_SET_SUPPORT_EMAIL:
            await handleSetSupportEmailPrompt(chatId, telegramId);
            return;
        case BTN_GENERATE_INVITE:
            await handleGenerateInvitePrompt(chatId, telegramId);
            return;
        default:
            await safeSendMessage(chatId, '❓ Please use the menu buttons below.');
            await showAdminMenu(chatId, telegramId);
    }
}

// ----------------------------------------------------------------------------
// MASTER MESSAGE HANDLER
// ----------------------------------------------------------------------------
async function handleMessage(msg) {
    if (!msg || !msg.from || msg.from.is_bot) return;
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const text = (msg.text || '').trim();

    if (!text) return;

    if (text.startsWith('/start')) {
        await handleStart(msg);
        return;
    }

    const admin = isAdmin(telegramId);
    const state = await getUserState(telegramId);

    // Free-text input states take priority over menu checks (except Back, handled inside dispatch).
    if (text === BTN_BACK) {
        await dispatchMenuButton(msg, text);
        return;
    }

    if (state && !['menu_main', 'menu_admin', 'menu_settings'].includes(state.state)) {
        await handleStateInput(msg, state);
        return;
    }

    if (!admin) {
        const user = await getUser(telegramId);
        if (!user) {
            await safeSendMessage(chatId, '👋 Please send /start to begin.');
            return;
        }

        const settings = await getSettings();

        if (!settings.bot_enabled) {
            await safeSendMessage(chatId, '🛠 The bot is currently under maintenance. Please try again later.');
            return;
        }
        if (user.is_banned) {
            await safeSendMessage(chatId, '🚫 You have been banned from using this bot.');
            return;
        }
        if (settings.approval_required && !user.is_approved) {
            await safeSendMessage(chatId, '⏳ Your account is pending admin approval. Please wait.');
            return;
        }
        if (user.cooldown_until && new Date(user.cooldown_until) > new Date()) {
            const minsLeft = Math.ceil((new Date(user.cooldown_until) - new Date()) / 60000);
            await safeSendMessage(chatId, `🧊 You are in cooldown due to sending too many messages. Try again in ${minsLeft} minute(s).`);
            return;
        }

        const { data: updatedUser, error: rpcError } = await supabase.rpc('register_user_message', {
            p_telegram_id: telegramId,
        });
        if (rpcError) {
            console.error('register_user_message error:', rpcError.message);
        } else if (updatedUser) {
            const justCooledDown =
                updatedUser.cooldown_until && new Date(updatedUser.cooldown_until) > new Date() && !user.cooldown_until;
            if (justCooledDown) {
                const minsLeft = Math.ceil((new Date(updatedUser.cooldown_until) - new Date()) / 60000);
                await safeSendMessage(
                    chatId,
                    `🧊 You have been placed in cooldown for sending too many messages too quickly. Try again in ${minsLeft} minute(s).`
                );
                return;
            }
            if (updatedUser.daily_message_count > settings.daily_message_limit) {
                await safeSendMessage(chatId, '📊 You have reached your daily message limit. Please try again tomorrow.');
                return;
            }
        }
    }

    await dispatchMenuButton(msg, text);
}

// ----------------------------------------------------------------------------
// EXPRESS APP / VERCEL SERVERLESS HANDLER
// ----------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.post('/api/bot', async (req, res) => {
    try {
        await handleMessage(req.body?.message || req.body?.edited_message);
    } catch (err) {
        console.error('Webhook processing error:', err);
    }
    res.sendStatus(200);
});

app.get('/api/bot', async (req, res) => {
    if (req.query.cron === 'cleanup') {
        try {
            const { data, error } = await supabase.rpc('run_full_cleanup');
            if (error) throw error;
            res.json({ ok: true, result: data });
        } catch (err) {
            console.error('Cleanup cron error:', err.message);
            res.status(500).json({ ok: false, error: err.message });
        }
        return;
    }

    try {
        const host = req.headers['x-forwarded-host'] || req.headers.host || process.env.VERCEL_URL;
        if (host) {
            const webhookUrl = `https://${host}/api/bot`;
            await bot.setWebHook(webhookUrl);
            res.send(`Bot is running. Webhook set to ${webhookUrl}`);
            return;
        }
        res.send('Bot is running. Unable to auto-detect host for webhook setup.');
    } catch (err) {
        console.error('Webhook setup error:', err.message);
        res.status(500).send('Bot is running, but webhook setup failed. Check logs.');
    }
});

if (!process.env.VERCEL) {
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`Local server listening on port ${port}`));
}

export default app;
