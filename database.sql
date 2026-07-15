-- ============================================================================
-- TELEGRAM BOT DATABASE SCHEMA
-- Target: Supabase (PostgreSQL)
-- Run this entire file once in the Supabase SQL Editor before deploying.
-- Safe to re-run: all objects are created with IF NOT EXISTS / OR REPLACE.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- EXTENSIONS
-- ----------------------------------------------------------------------------
create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- TABLE: settings
-- Single-row configuration table controlling live bot behaviour.
-- ----------------------------------------------------------------------------
create table if not exists settings (
    id                          smallint primary key default 1,
    bot_enabled                 boolean not null default true,
    approval_required           boolean not null default true,
    welcome_message             text not null default '👋 Welcome! Your account has been registered successfully.',
    support_message             text not null default '🎧 Need help? Reach out to our support team and we will get back to you shortly.',
    support_email               text not null default 'support@example.com',
    daily_message_limit         integer not null default 2,
    max_users                   integer not null default 1000,
    cooldown_minutes            integer not null default 20,
    spam_message_threshold      integer not null default 7,
    spam_window_seconds         integer not null default 30,
    email_api_key               text,
    email_api_url               text not null default 'https://api.resend.com/emails',
    email_from_address          text not null default 'onboarding@resend.dev',
    updated_at                  timestamptz not null default now(),
    constraint settings_singleton check (id = 1)
);

insert into settings (id)
values (1)
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- TABLE: admins
-- Dynamic admin registry (in addition to the ADMIN_IDS environment variable).
-- ----------------------------------------------------------------------------
create table if not exists admins (
    telegram_id     bigint primary key,
    added_by        bigint,
    is_super_admin  boolean not null default false,
    created_at      timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- TABLE: invites
-- Invite codes required for new users to register.
-- ----------------------------------------------------------------------------
create table if not exists invites (
    id              uuid primary key default gen_random_uuid(),
    code            text not null unique,
    created_by      bigint not null,
    max_uses        integer not null default 5,
    use_count       integer not null default 0,
    is_active       boolean not null default true,
    created_at      timestamptz not null default now(),
    expired_at      timestamptz
);

create index if not exists idx_invites_code on invites (code);
create index if not exists idx_invites_active on invites (is_active);

-- ----------------------------------------------------------------------------
-- TABLE: invite_uses
-- Records which user consumed which invite (audit trail).
-- ----------------------------------------------------------------------------
create table if not exists invite_uses (
    id              uuid primary key default gen_random_uuid(),
    invite_id       uuid not null references invites (id) on delete cascade,
    telegram_id     bigint not null,
    used_at         timestamptz not null default now()
);

create index if not exists idx_invite_uses_invite_id on invite_uses (invite_id);

-- ----------------------------------------------------------------------------
-- TABLE: users
-- Core user registry with approval, ban, limit and cooldown state.
-- ----------------------------------------------------------------------------
create table if not exists users (
    telegram_id             bigint primary key,
    username                text,
    first_name              text,
    last_name               text,
    invite_code_used        text,
    is_approved             boolean not null default false,
    is_banned               boolean not null default false,
    ban_reason              text,
    daily_message_count     integer not null default 0,
    daily_reset_date        date not null default current_date,
    total_messages          integer not null default 0,
    consecutive_msg_count   integer not null default 0,
    consecutive_msg_window  timestamptz,
    cooldown_until          timestamptz,
    joined_at               timestamptz not null default now(),
    last_seen_at            timestamptz not null default now()
);

create index if not exists idx_users_is_approved on users (is_approved);
create index if not exists idx_users_is_banned on users (is_banned);
create index if not exists idx_users_joined_at on users (joined_at);
create index if not exists idx_users_cooldown_until on users (cooldown_until);

-- ----------------------------------------------------------------------------
-- TABLE: user_states
-- Persists multi-step admin/user conversation state across serverless
-- invocations (Vercel functions do not share memory between requests).
-- ----------------------------------------------------------------------------
create table if not exists user_states (
    telegram_id     bigint primary key,
    state           text not null,
    data            jsonb not null default '{}'::jsonb,
    updated_at      timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- TABLE: broadcasts
-- History of broadcast messages sent by admins.
-- ----------------------------------------------------------------------------
create table if not exists broadcasts (
    id              uuid primary key default gen_random_uuid(),
    sent_by         bigint not null,
    message         text not null,
    success_count   integer not null default 0,
    fail_count      integer not null default 0,
    created_at      timestamptz not null default now()
);

create index if not exists idx_broadcasts_created_at on broadcasts (created_at);

-- ----------------------------------------------------------------------------
-- TABLE: logs
-- Full audit log of every meaningful bot action.
-- ----------------------------------------------------------------------------
create table if not exists logs (
    id              bigint generated always as identity primary key,
    action_type     text not null,
    actor_id        bigint,
    target_id       bigint,
    details         jsonb not null default '{}'::jsonb,
    created_at      timestamptz not null default now()
);

create index if not exists idx_logs_action_type on logs (action_type);
create index if not exists idx_logs_created_at on logs (created_at);
create index if not exists idx_logs_actor_id on logs (actor_id);

-- ----------------------------------------------------------------------------
-- TABLE: product_orders
-- Records of the product confirmation emails sent through the bot.
-- ----------------------------------------------------------------------------
create table if not exists product_orders (
    id              bigint generated always as identity primary key,
    telegram_id     bigint not null,
    product_name    text not null,
    email_sent      boolean not null default false,
    created_at      timestamptz not null default now()
);

create index if not exists idx_product_orders_telegram_id on product_orders (telegram_id);

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Keeps settings.updated_at accurate on every update.
create or replace function touch_settings_updated_at()
returns trigger as $$
begin
    new.updated_at := now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists trg_settings_updated_at on settings;
create trigger trg_settings_updated_at
before update on settings
for each row execute function touch_settings_updated_at();

-- Resets a user's daily message counter if the stored reset date is stale.
-- Returns the up-to-date remaining count as an integer.
create or replace function reset_daily_count_if_needed(p_telegram_id bigint)
returns void as $$
begin
    update users
    set daily_message_count = 0,
        daily_reset_date = current_date
    where telegram_id = p_telegram_id
      and daily_reset_date < current_date;
end;
$$ language plpgsql;

-- Atomically registers one message from a user: resets stale daily counters,
-- increments counters, and evaluates spam-cooldown thresholds using values
-- pulled live from the settings table. Returns the resulting row so the
-- application can decide how to respond without a race condition.
create or replace function register_user_message(p_telegram_id bigint)
returns users as $$
declare
    v_settings settings%rowtype;
    v_user users%rowtype;
    v_window_seconds integer;
    v_threshold integer;
    v_cooldown_minutes integer;
begin
    select * into v_settings from settings where id = 1;
    v_window_seconds := coalesce(v_settings.spam_window_seconds, 30);
    v_threshold := coalesce(v_settings.spam_message_threshold, 7);
    v_cooldown_minutes := coalesce(v_settings.cooldown_minutes, 20);

    update users
    set daily_message_count = case
            when daily_reset_date < current_date then 1
            else daily_message_count + 1
        end,
        daily_reset_date = current_date,
        total_messages = total_messages + 1,
        consecutive_msg_count = case
            when consecutive_msg_window is null
                 or now() - consecutive_msg_window > (v_window_seconds || ' seconds')::interval
                then 1
            else consecutive_msg_count + 1
        end,
        consecutive_msg_window = case
            when consecutive_msg_window is null
                 or now() - consecutive_msg_window > (v_window_seconds || ' seconds')::interval
                then now()
            else consecutive_msg_window
        end,
        cooldown_until = case
            when (case
                    when consecutive_msg_window is null
                         or now() - consecutive_msg_window > (v_window_seconds || ' seconds')::interval
                        then 1
                    else consecutive_msg_count + 1
                  end) >= v_threshold
                then now() + (v_cooldown_minutes || ' minutes')::interval
            else cooldown_until
        end,
        last_seen_at = now()
    where telegram_id = p_telegram_id
    returning * into v_user;

    return v_user;
end;
$$ language plpgsql;

-- Atomically claims one use of an invite code. Returns the invite row if the
-- claim succeeded, or NULL if the code is invalid, inactive, or exhausted.
-- Using a single UPDATE ... RETURNING avoids a check-then-act race condition.
create or replace function claim_invite(p_code text)
returns invites as $$
declare
    v_invite invites%rowtype;
begin
    update invites
    set use_count = use_count + 1,
        is_active = case when use_count + 1 >= max_uses then false else is_active end,
        expired_at = case when use_count + 1 >= max_uses then now() else expired_at end
    where code = p_code
      and is_active = true
      and use_count < max_uses
    returning * into v_invite;

    return v_invite;
end;
$$ language plpgsql;

-- Cleanup: clears cooldowns that have already expired, freeing the row from
-- unnecessary future date comparisons.
create or replace function cleanup_expired_cooldowns()
returns integer as $$
declare
    v_count integer;
begin
    with updated as (
        update users
        set cooldown_until = null
        where cooldown_until is not null
          and cooldown_until <= now()
        returning telegram_id
    )
    select count(*) into v_count from updated;

    return v_count;
end;
$$ language plpgsql;

-- Cleanup: deletes log entries older than the given retention window
-- (defaults to 90 days) to keep the logs table lean.
create or replace function cleanup_old_logs(p_retention_days integer default 90)
returns integer as $$
declare
    v_count integer;
begin
    with deleted as (
        delete from logs
        where created_at < now() - (p_retention_days || ' days')::interval
        returning id
    )
    select count(*) into v_count from deleted;

    return v_count;
end;
$$ language plpgsql;

-- Cleanup: deactivates invites whose usage cap has been reached but were
-- not flagged inactive (defensive safety net for the claim_invite logic).
create or replace function cleanup_exhausted_invites()
returns integer as $$
declare
    v_count integer;
begin
    with updated as (
        update invites
        set is_active = false,
            expired_at = now()
        where is_active = true
          and use_count >= max_uses
        returning id
    )
    select count(*) into v_count from updated;

    return v_count;
end;
$$ language plpgsql;

-- Full maintenance sweep combining all cleanup routines. Call this
-- periodically (e.g. from a Vercel cron hitting an admin-only endpoint).
create or replace function run_full_cleanup()
returns jsonb as $$
declare
    v_cooldowns integer;
    v_logs integer;
    v_invites integer;
begin
    v_cooldowns := cleanup_expired_cooldowns();
    v_logs := cleanup_old_logs();
    v_invites := cleanup_exhausted_invites();

    return jsonb_build_object(
        'cooldowns_cleared', v_cooldowns,
        'logs_deleted', v_logs,
        'invites_expired', v_invites,
        'ran_at', now()
    );
end;
$$ language plpgsql;

-- Danger zone: wipes all transactional data while preserving settings and
-- the admins table. Used by the "🗑 Clear Database" admin panel action.
create or replace function clear_all_data()
returns void as $$
begin
    truncate table
        product_orders,
        broadcasts,
        logs,
        invite_uses,
        invites,
        user_states,
        users
    restart identity cascade;
end;
$$ language plpgsql;

-- ============================================================================
-- STATISTICS VIEW
-- Live counters used by the "📈 Statistics" admin panel button.
-- ============================================================================
create or replace view v_bot_statistics as
select
    (select count(*) from users) as total_users,
    (select count(*) from users where is_approved = true and is_banned = false) as approved_users,
    (select count(*) from users where is_approved = false and is_banned = false) as pending_users,
    (select count(*) from users where is_banned = true) as banned_users,
    (select count(*) from users where joined_at::date = current_date) as todays_users,
    (select coalesce(sum(total_messages), 0) from users) as total_messages,
    (select count(*) from users where cooldown_until is not null and cooldown_until > now()) as cooldown_users,
    (select count(*) from invites where is_active = true) as active_invites,
    (select coalesce(sum(use_count), 0) from invites) as total_invite_uses,
    (select count(*) from broadcasts) as total_broadcasts,
    (select count(*) from product_orders) as total_product_orders;

-- ============================================================================
-- END OF SCHEMA
-- ============================================================================
