// Import required packages
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

// Bot configuration
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers
    ]
});

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const MONITORED_FORUM_ID = process.env.MONITORED_FORUM_ID; // Forum ID to monitor
const ADMIN_REPORT_CHANNEL_ID = process.env.ADMIN_REPORT_CHANNEL_ID; // Admin reporting channel (used for reports and bot commands)
const CLIENT_ROLE_ID = process.env.CLIENT_ROLE_ID; // The role ID for "Client"
const EXCLUDED_DAYS = [6, 0]; // Saturday and Sunday
const BUSINESS_HOURS = { start: 9, end: 17 }; // Business hours (9 AM to 5 PM)

// SQLite setup for persistent storage
const db = new sqlite3.Database('./reminders.db', (err) => {
    if (err) {
        console.error(err.message);
    } else {
        console.log('Connected to the SQLite database.');

        // Ensure the 'reminders' table exists
        db.run(`CREATE TABLE IF NOT EXISTS reminders (
            userId TEXT,
            threadId TEXT,
            timestamp TEXT,
            reminderHours INTEGER DEFAULT 24
        )`, (err) => {
            if (err) {
                console.error("Error creating reminders table:", err.message);
            } else {
                console.log("Reminders table created or verified.");
            }
        });
    }
});

// Logger
const logger = fs.createWriteStream('bot_activity.log', { flags: 'a' });

// Track messages and responses
let pendingResponses = {};

// Function to calculate delay (excluding weekends and non-business hours)
function calculateDelay(startDate, hours) {
    let delay = 0;
    let tempDate = new Date(startDate);

    while (delay < hours * 60 * 60 * 1000) {
        tempDate.setHours(tempDate.getHours() + 1);
        if (!EXCLUDED_DAYS.includes(tempDate.getDay()) &&
            tempDate.getHours() >= BUSINESS_HOURS.start &&
            tempDate.getHours() < BUSINESS_HOURS.end) {
            delay += 60 * 60 * 1000; // Add one hour
        }
    }
    return delay;
}

// Function to check if a member has the "Client" role
async function isClient(guild, userId) {
    try {
        const member = await guild.members.fetch(userId);
        return member.roles.cache.has(CLIENT_ROLE_ID);
    } catch (err) {
        console.error(`Error fetching member:`, err);
        return false;
    }
}

// Monitor existing threads and manage reminders
function monitorExistingThreads() {
    const forum = client.channels.cache.get(MONITORED_FORUM_ID);
    if (!forum) {
        console.error('Forum channel not found.');
        return;
    }

    forum.threads.fetchActive().then(threads => {
        threads.threads.forEach(thread => {
            console.log(`Monitoring existing thread: ${thread.name} (ID: ${thread.id})`);

            // Join the thread so we can listen to its messages
            thread.join().then(() => {
                console.log(`Joined thread: ${thread.name}`);

                thread.messages.fetch({ limit: 10 }).then(messages => {
                    messages.forEach(async (message) => {
                        if (!message.author.bot) {
                            const userId = message.author.id;

                            // Only set timers for "Client" role users
                            const isClientUser = await isClient(message.guild, userId);
                            if (isClientUser) {
                                const currentTime = new Date();

                                // Check if the user already has a pending reminder
                                db.get(`SELECT * FROM reminders WHERE userId = ? AND threadId = ?`, [userId, thread.id], (err, row) => {
                                    if (err) {
                                        console.error(`Database error:`, err);
                                        return;
                                    }

                                    if (!row) {
                                        // No reminder exists, create a new one
                                        const reminderHours = 24;
                                        const delay = calculateDelay(currentTime, reminderHours);

                                        if (!pendingResponses[userId]) {
                                            pendingResponses[userId] = {};
                                        }
                                        pendingResponses[userId][thread.id] = {
                                            timestamp: currentTime,
                                            reminderHours,
                                            timeout: setTimeout(() => sendReminder(userId, thread, message), delay)
                                        };

                                        // Persist the reminder in the database
                                        db.run(`INSERT INTO reminders(userId, threadId, timestamp, reminderHours) VALUES(?, ?, ?, ?)`, [userId, thread.id, currentTime, reminderHours]);

                                        logActivity(`Started reminder for user ${userId} in thread ${thread.id}`);
                                    }
                                });
                            }
                        }
                    });
                }).catch(err => {
                    console.error(`Error fetching messages from thread ${thread.id}:`, err);
                });
            }).catch(err => {
                console.error(`Error joining thread ${thread.id}:`, err);
            });
        });
    }).catch(err => {
        console.error('Error fetching active threads:', err);
    });
}

// Function to send reminder DM and notify the admin reporting channel
function sendReminder(userId, thread, originalMessage) {
    const user = client.users.cache.get(userId);
    if (user) {
        const dmMessage = `Hey, it looks like you haven't responded in the thread "${thread.name}". The other participants are still waiting for your response regarding this message: "${originalMessage.content}".`;
        user.send(dmMessage).catch(err => {
            console.error(`Error sending DM to user ${userId}:`, err);
        });

        logActivity(`Sent reminder to user ${userId} for thread ${thread.name}`);

        const adminChannel = client.channels.cache.get(ADMIN_REPORT_CHANNEL_ID);
        if (adminChannel) {
            adminChannel.send(`Reminder sent to <@${userId}> for thread "${thread.name}".`);
        }

        // Remove reminder after sending it
        db.run('DELETE FROM reminders WHERE userId = ? AND threadId = ?', [userId, thread.id]);
        delete pendingResponses[userId][thread.id];
    }
}

// Function to reset timers (admin only)
client.on('messageCreate', message => {
    if (message.channel.id === ADMIN_REPORT_CHANNEL_ID && message.member.permissions.has('ADMINISTRATOR')) {
        if (message.content.toLowerCase() === '!resettimers') {
            pendingResponses = {}; // Clear in-memory timers
            db.run('DELETE FROM reminders', (err) => {
                if (err) {
                    message.channel.send('Error resetting timers.');
                } else {
                    message.channel.send('All timers have been reset.');
                    monitorExistingThreads(); // Restart timers
                }
            });
        }
    }
});

// Log activity function
function logActivity(message) {
    logger.write(`${new Date().toISOString()} - ${message}\n`);
}

// Restore reminders and monitor existing threads on bot start
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    monitorExistingThreads(); // Monitor existing threads when the bot starts
});

// Log the bot in
client.login(TOKEN);
