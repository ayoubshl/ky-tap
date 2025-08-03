const { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType, EmbedBuilder, ActivityType } = require('discord.js');
require('dotenv').config();

class YourDungeonBot {
    constructor() {
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildVoiceStates,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });

        // In-memory storage
        this.activeDungeons = new Map(); // channelId -> { ownerId, createdAt, isLocked, invitedUsers, userLimit, guildId }
        this.deletionTimers = new Map(); // channelId -> timeoutId
        
        // Configuration
        this.TRIGGER_CHANNEL_NAME = '🎙️ your-dungeon';
        this.DUNGEONS_CATEGORY_NAME = 'DUNGEONS';
        this.COMMAND_PREFIX = '.d ';
        this.DELETION_TIMEOUT = 2 * 60 * 1000; // 2 minutes
        
        this.setupEventHandlers();
        this.setupGracefulShutdown();
    }

    setupEventHandlers() {
        this.client.once('ready', () => {
            console.log(`✅ ${this.client.user.tag} is online and ready!`);
            this.client.user.setActivity('Managing Dungeons', { type: ActivityType.Watching });
            this.cleanupOrphanedChannels();
        });

        this.client.on('voiceStateUpdate', (oldState, newState) => {
            this.handleVoiceStateUpdate(oldState, newState);
        });

        this.client.on('messageCreate', (message) => {
            this.handleMessage(message);
        });

        this.client.on('error', (error) => {
            console.error('❌ Discord client error:', error);
        });
    }

    async handleVoiceStateUpdate(oldState, newState) {
        try {
            // Handle joining trigger channel
            if (newState.channel && newState.channel.name === this.TRIGGER_CHANNEL_NAME) {
                await this.createDungeon(newState.member, newState.guild);
            }

            // Handle leaving dungeons
            if (oldState.channel && this.activeDungeons.has(oldState.channel.id)) {
                await this.handleDungeonLeave(oldState.channel);
            }

            // Handle joining dungeons (cancel deletion if someone joins)
            if (newState.channel && this.activeDungeons.has(newState.channel.id)) {
                await this.handleDungeonJoin(newState.channel);
            }
        } catch (error) {
            console.error('❌ Error handling voice state update:', error);
        }
    }

    async createDungeon(member, guild) {
        try {
            // Check permissions
            if (!guild.members.me.permissions.has([
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.MoveMembers,
                PermissionFlagsBits.Connect
            ])) {
                console.error('❌ Missing required permissions to create dungeons');
                return;
            }

            // Find or create DUNGEONS category
            let category = guild.channels.cache.find(
                c => c.type === ChannelType.GuildCategory && c.name === this.DUNGEONS_CATEGORY_NAME
            );

            if (!category) {
                category = await guild.channels.create({
                    name: this.DUNGEONS_CATEGORY_NAME,
                    type: ChannelType.GuildCategory,
                    permissionOverwrites: [
                        {
                            id: guild.roles.everyone,
                            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
                            deny: [PermissionFlagsBits.ManageChannels]
                        }
                    ]
                });
                console.log(`📁 Created DUNGEONS category`);
            }

            // Create the dungeon voice channel
            const dungeonName = `${member.displayName}'s Dungeon`;
            const dungeonChannel = await guild.channels.create({
                name: dungeonName,
                type: ChannelType.GuildVoice,
                parent: category.id,
                permissionOverwrites: [
                    {
                        id: guild.roles.everyone,
                        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak],
                        deny: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers]
                    },
                    {
                        id: member.id,
                        allow: [
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.Connect,
                            PermissionFlagsBits.Speak,
                            PermissionFlagsBits.ManageChannels,
                            PermissionFlagsBits.MoveMembers,
                            PermissionFlagsBits.MuteMembers,
                            PermissionFlagsBits.DeafenMembers
                        ]
                    }
                ]
            });

            // Store dungeon data
            this.activeDungeons.set(dungeonChannel.id, {
                ownerId: member.id,
                createdAt: Date.now(),
                isLocked: false,
                invitedUsers: new Set(),
                userLimit: null,
                guildId: guild.id
            });

            // Move user to their dungeon
            await this.retryOperation(() => member.voice.setChannel(dungeonChannel));

            console.log(`🏰 Created dungeon "${dungeonName}" for ${member.displayName}`);

            // Send welcome message
            await this.sendWelcomeMessage(dungeonChannel, member);

        } catch (error) {
            console.error('❌ Error creating dungeon:', error);
        }
    }

    async handleDungeonLeave(channel) {
        const realUsers = channel.members.filter(member => !member.user.bot);
        
        if (realUsers.size === 0) {
            // Start deletion timer
            this.startDeletionTimer(channel.id);
        }
    }

    async handleDungeonJoin(channel) {
        const realUsers = channel.members.filter(member => !member.user.bot);
        
        if (realUsers.size > 0) {
            // Cancel deletion timer if users are present
            this.cancelDeletionTimer(channel.id);
        }
    }

    startDeletionTimer(channelId) {
        // Cancel existing timer if any
        this.cancelDeletionTimer(channelId);

        const timeoutId = setTimeout(async () => {
            await this.deleteDungeon(channelId, 'Auto-deletion (empty for 2 minutes)');
        }, this.DELETION_TIMEOUT);

        this.deletionTimers.set(channelId, timeoutId);
        console.log(`⏱️ Started deletion timer for dungeon ${channelId}`);
    }

    cancelDeletionTimer(channelId) {
        const timeoutId = this.deletionTimers.get(channelId);
        if (timeoutId) {
            clearTimeout(timeoutId);
            this.deletionTimers.delete(channelId);
            console.log(`⏹️ Cancelled deletion timer for dungeon ${channelId}`);
        }
    }

    async deleteDungeon(channelId, reason = 'Manual deletion') {
        try {
            const dungeonData = this.activeDungeons.get(channelId);
            if (!dungeonData) return;

            const channel = this.client.channels.cache.get(channelId);
            if (channel) {
                await this.retryOperation(() => channel.delete());
                console.log(`🗑️ Deleted dungeon ${channel.name} - ${reason}`);
            }

            // Clean up data
            this.activeDungeons.delete(channelId);
            this.cancelDeletionTimer(channelId);
        } catch (error) {
            console.error('❌ Error deleting dungeon:', error);
        }
    }

    async handleMessage(message) {
        if (message.author.bot || !message.content.startsWith(this.COMMAND_PREFIX)) return;

        const channel = message.channel;
        const voiceChannel = message.member?.voice?.channel;

        // Check if user is in a dungeon
        if (!voiceChannel || !this.activeDungeons.has(voiceChannel.id)) {
            return;
        }

        const dungeonData = this.activeDungeons.get(voiceChannel.id);
        const args = message.content.slice(this.COMMAND_PREFIX.length).trim().split(' ');
        const command = args[0].toLowerCase();

        try {
            switch (command) {
                case 'help':
                    await this.sendHelpEmbed(message);
                    break;
                case 'info':
                    await this.sendInfoEmbed(message, voiceChannel, dungeonData);
                    break;
                case 'lock':
                    await this.lockDungeon(message, voiceChannel, dungeonData);
                    break;
                case 'unlock':
                    await this.unlockDungeon(message, voiceChannel, dungeonData);
                    break;
                case 'invite':
                    await this.inviteUser(message, voiceChannel, dungeonData, args);
                    break;
                case 'kick':
                    await this.kickUser(message, voiceChannel, dungeonData, args);
                    break;
                case 'limit':
                    await this.setUserLimit(message, voiceChannel, dungeonData, args);
                    break;
                case 'rename':
                    await this.renameDungeon(message, voiceChannel, dungeonData, args);
                    break;
                case 'end':
                    await this.endDungeon(message, voiceChannel, dungeonData);
                    break;
                case 'claim':
                    await this.claimDungeon(message, voiceChannel, dungeonData);
                    break;
                case 'extend':
                    await this.extendDungeon(message, voiceChannel);
                    break;
                default:
                    await this.sendErrorEmbed(message, 'Unknown command. Use `.d help` for available commands.');
            }
        } catch (error) {
            console.error(`❌ Error executing command ${command}:`, error);
            await this.sendErrorEmbed(message, 'An error occurred while executing the command.');
        }
    }

    async sendHelpEmbed(message) {
        const embed = new EmbedBuilder()
            .setTitle('🏰 Dungeon Commands')
            .setColor(0x7289DA)
            .setDescription('Available commands for managing your dungeon:')
            .addFields(
                { name: '📋 `.d info`', value: 'Show dungeon information', inline: true },
                { name: '🔒 `.d lock`', value: 'Lock the dungeon', inline: true },
                { name: '🔓 `.d unlock`', value: 'Unlock the dungeon', inline: true },
                { name: '📨 `.d invite @user`', value: 'Invite a user to locked dungeon', inline: true },
                { name: '👢 `.d kick @user`', value: 'Kick a user from dungeon', inline: true },
                { name: '👥 `.d limit [number]`', value: 'Set user limit', inline: true },
                { name: '✏️ `.d rename [name]`', value: 'Rename the dungeon', inline: true },
                { name: '🗑️ `.d end`', value: 'Delete the dungeon', inline: true },
                { name: '👑 `.d claim`', value: 'Claim an empty dungeon', inline: true },
                { name: '⏰ `.d extend`', value: 'Extend auto-deletion timer', inline: true }
            )
            .setTimestamp();

        await message.reply({ embeds: [embed] });
    }

    async sendInfoEmbed(message, voiceChannel, dungeonData) {
        const owner = await this.client.users.fetch(dungeonData.ownerId);
        const users = voiceChannel.members.filter(m => !m.user.bot).map(m => m.displayName).join(', ') || 'None';
        const status = dungeonData.isLocked ? '🔒 Locked' : '🔓 Unlocked';
        const limit = dungeonData.userLimit ? `${dungeonData.userLimit} users` : 'No limit';
        
        let deletionInfo = '';
        if (this.deletionTimers.has(voiceChannel.id)) {
            deletionInfo = `⏱️ **Auto-deletion:** ${this.formatTime(120)} remaining`;
        }

        const embed = new EmbedBuilder()
            .setTitle(`🏰 ${voiceChannel.name}`)
            .setColor(0x00FF00)
            .addFields(
                { name: '👑 Owner', value: owner.displayName, inline: true },
                { name: '🔒 Status', value: status, inline: true },
                { name: '👥 User Limit', value: limit, inline: true },
                { name: '📋 Users Inside', value: users, inline: false }
            )
            .setTimestamp();

        if (deletionInfo) {
            embed.addFields({ name: 'Auto-Deletion', value: deletionInfo, inline: false });
        }

        await message.reply({ embeds: [embed] });
    }

    async lockDungeon(message, voiceChannel, dungeonData) {
        if (message.author.id !== dungeonData.ownerId) {
            await this.sendErrorEmbed(message, 'Only the dungeon owner can lock it.');
            return;
        }

        await voiceChannel.permissionOverwrites.edit(message.guild.roles.everyone, {
            Connect: false
        });

        dungeonData.isLocked = true;
        await this.sendSuccessEmbed(message, '🔒 Dungeon locked! Only invited users can join.');
    }

    async unlockDungeon(message, voiceChannel, dungeonData) {
        if (message.author.id !== dungeonData.ownerId) {
            await this.sendErrorEmbed(message, 'Only the dungeon owner can unlock it.');
            return;
        }

        await voiceChannel.permissionOverwrites.edit(message.guild.roles.everyone, {
            Connect: true
        });

        dungeonData.isLocked = false;
        dungeonData.invitedUsers.clear();
        await this.sendSuccessEmbed(message, '🔓 Dungeon unlocked! Anyone can join now.');
    }

    async inviteUser(message, voiceChannel, dungeonData, args) {
        if (message.author.id !== dungeonData.ownerId) {
            await this.sendErrorEmbed(message, 'Only the dungeon owner can invite users.');
            return;
        }

        const user = message.mentions.users.first();
        if (!user) {
            await this.sendErrorEmbed(message, 'Please mention a user to invite.');
            return;
        }

        await voiceChannel.permissionOverwrites.edit(user.id, {
            Connect: true
        });

        dungeonData.invitedUsers.add(user.id);
        await this.sendSuccessEmbed(message, `📨 Invited ${user.displayName} to the dungeon!`);
    }

    async kickUser(message, voiceChannel, dungeonData, args) {
        if (message.author.id !== dungeonData.ownerId) {
            await this.sendErrorEmbed(message, 'Only the dungeon owner can kick users.');
            return;
        }

        const user = message.mentions.users.first();
        if (!user) {
            await this.sendErrorEmbed(message, 'Please mention a user to kick.');
            return;
        }

        const member = message.guild.members.cache.get(user.id);
        if (member && member.voice.channel === voiceChannel) {
            await this.retryOperation(() => member.voice.disconnect());
            await this.sendSuccessEmbed(message, `👢 Kicked ${user.displayName} from the dungeon!`);
        } else {
            await this.sendErrorEmbed(message, 'User is not in this dungeon.');
        }
    }

    async setUserLimit(message, voiceChannel, dungeonData, args) {
        if (message.author.id !== dungeonData.ownerId) {
            await this.sendErrorEmbed(message, 'Only the dungeon owner can set the user limit.');
            return;
        }

        const limit = parseInt(args[1]);
        if (isNaN(limit) || limit < 0 || limit > 99) {
            await this.sendErrorEmbed(message, 'Please provide a valid number between 0-99 (0 = no limit).');
            return;
        }

        const userLimit = limit === 0 ? null : limit;
        await voiceChannel.setUserLimit(userLimit);
        
        dungeonData.userLimit = userLimit;
        const limitText = userLimit ? `${userLimit} users` : 'No limit';
        await this.sendSuccessEmbed(message, `👥 User limit set to: ${limitText}`);
    }

    async renameDungeon(message, voiceChannel, dungeonData, args) {
        if (message.author.id !== dungeonData.ownerId) {
            await this.sendErrorEmbed(message, 'Only the dungeon owner can rename it.');
            return;
        }

        const newName = args.slice(1).join(' ');
        if (!newName || newName.length > 100) {
            await this.sendErrorEmbed(message, 'Please provide a valid name (1-100 characters).');
            return;
        }

        await voiceChannel.setName(newName);
        await this.sendSuccessEmbed(message, `✏️ Dungeon renamed to: "${newName}"`);
    }

    async endDungeon(message, voiceChannel, dungeonData) {
        if (message.author.id !== dungeonData.ownerId) {
            await this.sendErrorEmbed(message, 'Only the dungeon owner can end the dungeon.');
            return;
        }

        await this.sendSuccessEmbed(message, '🗑️ Dungeon will be deleted in 3 seconds...');
        setTimeout(() => {
            this.deleteDungeon(voiceChannel.id, 'Manual deletion by owner');
        }, 3000);
    }

    async claimDungeon(message, voiceChannel, dungeonData) {
        const realUsers = voiceChannel.members.filter(m => !m.user.bot);
        
        if (realUsers.size > 1) {
            await this.sendErrorEmbed(message, 'Cannot claim a dungeon with multiple users.');
            return;
        }

        if (dungeonData.ownerId === message.author.id) {
            await this.sendErrorEmbed(message, 'You already own this dungeon.');
            return;
        }

        // Transfer ownership
        dungeonData.ownerId = message.author.id;
        dungeonData.isLocked = false;
        dungeonData.invitedUsers.clear();

        // Update permissions
        const oldOwner = await this.client.users.fetch(dungeonData.ownerId);
        await voiceChannel.permissionOverwrites.edit(oldOwner.id, {
            ManageChannels: false,
            MoveMembers: false,
            MuteMembers: false,
            DeafenMembers: false
        });

        await voiceChannel.permissionOverwrites.edit(message.author.id, {
            ViewChannel: true,
            Connect: true,
            Speak: true,
            ManageChannels: true,
            MoveMembers: true,
            MuteMembers: true,
            DeafenMembers: true
        });

        this.cancelDeletionTimer(voiceChannel.id);
        await this.sendSuccessEmbed(message, '👑 You are now the owner of this dungeon!');
    }

    async extendDungeon(message, voiceChannel) {
        if (this.deletionTimers.has(voiceChannel.id)) {
            this.cancelDeletionTimer(voiceChannel.id);
            this.startDeletionTimer(voiceChannel.id);
            await this.sendSuccessEmbed(message, '⏰ Auto-deletion timer extended by 2 minutes!');
        } else {
            await this.sendErrorEmbed(message, 'No active deletion timer to extend.');
        }
    }

    async sendWelcomeMessage(dungeonChannel, member) {
        try {
            // Try to find a text channel to send welcome message
            const guild = dungeonChannel.guild;
            let textChannel = null;

            // Look for general channels
            const generalChannels = guild.channels.cache.filter(c => 
                c.type === ChannelType.GuildText && 
                (c.name.includes('general') || c.name.includes('chat'))
            );

            if (generalChannels.size > 0) {
                textChannel = generalChannels.first();
            } else {
                // Fallback to first available text channel
                textChannel = guild.channels.cache.find(c => c.type === ChannelType.GuildText);
            }

            if (textChannel) {
                const embed = new EmbedBuilder()
                    .setTitle('🏰 New Dungeon Created!')
                    .setDescription(`${member.displayName} created a private dungeon!`)
                    .addFields(
                        { name: '📍 Channel', value: `<#${dungeonChannel.id}>`, inline: true },
                        { name: '💬 Commands', value: 'Use `.d help` in voice chat for commands', inline: true }
                    )
                    .setColor(0x00FF00)
                    .setTimestamp();

                await textChannel.send({ embeds: [embed] });
            }
        } catch (error) {
            console.error('❌ Error sending welcome message:', error);
        }
    }

    async sendSuccessEmbed(message, text) {
        const embed = new EmbedBuilder()
            .setDescription(`✅ ${text}`)
            .setColor(0x00FF00);
        await message.reply({ embeds: [embed] });
    }

    async sendErrorEmbed(message, text) {
        const embed = new EmbedBuilder()
            .setDescription(`❌ ${text}`)
            .setColor(0xFF0000);
        await message.reply({ embeds: [embed] });
    }

    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    async retryOperation(operation, maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await operation();
            } catch (error) {
                if (i === maxRetries - 1) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
            }
        }
    }

    async cleanupOrphanedChannels() {
        console.log('🧹 Cleaning up orphaned dungeon channels...');
        
        for (const guild of this.client.guilds.cache.values()) {
            try {
                const category = guild.channels.cache.find(
                    c => c.type === ChannelType.GuildCategory && c.name === this.DUNGEONS_CATEGORY_NAME
                );

                if (!category) continue;

                const dungeonChannels = category.children.cache.filter(c => c.type === ChannelType.GuildVoice);
                
                for (const [channelId, channel] of dungeonChannels) {
                    const realUsers = channel.members.filter(m => !m.user.bot);
                    
                    if (realUsers.size === 0) {
                        await this.retryOperation(() => channel.delete());
                        console.log(`🗑️ Cleaned up orphaned channel: ${channel.name}`);
                    } else {
                        // Restore to active dungeons if it has users
                        if (!this.activeDungeons.has(channelId)) {
                            const firstUser = realUsers.first();
                            this.activeDungeons.set(channelId, {
                                ownerId: firstUser.id,
                                createdAt: Date.now(),
                                isLocked: false,
                                invitedUsers: new Set(),
                                userLimit: channel.userLimit || null,
                                guildId: guild.id
                            });
                            console.log(`🔄 Restored dungeon to active list: ${channel.name}`);
                        }
                    }
                }
            } catch (error) {
                console.error(`❌ Error cleaning up guild ${guild.name}:`, error);
            }
        }
    }

    setupGracefulShutdown() {
        const cleanup = async () => {
            console.log('\n🛑 Shutting down bot...');
            
            // Cancel all deletion timers
            for (const timeoutId of this.deletionTimers.values()) {
                clearTimeout(timeoutId);
            }

            // Clean up empty dungeons
            const deletionPromises = [];
            for (const [channelId, dungeonData] of this.activeDungeons) {
                try {
                    const channel = this.client.channels.cache.get(channelId);
                    if (channel) {
                        const realUsers = channel.members.filter(m => !m.user.bot);
                        if (realUsers.size === 0) {
                            deletionPromises.push(
                                this.retryOperation(() => channel.delete())
                                    .then(() => console.log(`🗑️ Cleaned up empty dungeon: ${channel.name}`))
                                    .catch(err => console.error(`❌ Error cleaning up ${channel.name}:`, err))
                            );
                        }
                    }
                } catch (error) {
                    console.error(`❌ Error during cleanup of channel ${channelId}:`, error);
                }
            }

            await Promise.allSettled(deletionPromises);
            
            this.client.destroy();
            console.log('✅ Bot shutdown complete');
            process.exit(0);
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        process.on('uncaughtException', (error) => {
            console.error('❌ Uncaught Exception:', error);
            cleanup();
        });
    }

    async start() {
        try {
            await this.client.login(process.env.DISCORD_TOKEN);
        } catch (error) {
            console.error('❌ Failed to start bot:', error);
            process.exit(1);
        }
    }
}

// Create and start the bot
const bot = new YourDungeonBot();
bot.start();

module.exports = YourDungeonBot;