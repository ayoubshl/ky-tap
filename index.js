const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} = require("discord.js");
require("dotenv").config();

class YourDungeonBot {
  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    // Track active dungeons: Map<channelId, dungeonData>
    this.dungeons = new Map();

    // Track deletion timers: Map<channelId, timeoutId>
    this.deletionTimers = new Map();

    // Configuration
    this.config = {
      prefix: ".d ",
      triggerChannelName: "🎙️ your-dungeon",
      inactivityTimeout: 2 * 60 * 1000, // 2 minutes in milliseconds
      dungeonCategoryName: "DUNGEONS", // Optional: create dungeons in specific category
    };

    this.setupEventHandlers();
  }

  setupEventHandlers() {
    this.client.once("ready", () => {
      console.log(
        `✅ Your Dungeon Bot is ready! Logged in as ${this.client.user.tag}`
      );
      this.client.user.setActivity("🎙️ Creating dungeons", {
        type: "WATCHING",
      });
    });

    this.client.on("voiceStateUpdate", (oldState, newState) => {
      this.handleVoiceStateUpdate(oldState, newState);
    });

    this.client.on("messageCreate", (message) => {
      this.handleMessage(message);
    });

    this.client.on("error", console.error);
  }

  async handleVoiceStateUpdate(oldState, newState) {
    // User joined the trigger channel - create dungeon
    if (
      newState.channel &&
      newState.channel.name === this.config.triggerChannelName
    ) {
      await this.createDungeon(newState.member, newState.guild);
    }

    // Check if user left a dungeon
    if (oldState.channel && this.dungeons.has(oldState.channel.id)) {
      await this.checkDungeonEmpty(oldState.channel);
    }

    // Check if user joined a dungeon (cancel deletion timer)
    if (newState.channel && this.dungeons.has(newState.channel.id)) {
      this.cancelDeletionTimer(newState.channel.id);
    }
  }

  async createDungeon(member, guild) {
    try {
      // Check bot permissions first
      const botMember = guild.members.cache.get(this.client.user.id);
      const requiredPermissions = [
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.MoveMembers,
      ];

      const missingPermissions = requiredPermissions.filter(
        (perm) => !botMember.permissions.has(perm)
      );

      if (missingPermissions.length > 0) {
        console.error(
          `❌ Bot missing permissions: ${missingPermissions
            .map((p) =>
              Object.keys(PermissionFlagsBits).find(
                (key) => PermissionFlagsBits[key] === p
              )
            )
            .join(", ")}`
        );

        // Try to send error message to a general channel
        const generalChannel = guild.channels.cache.find(
          (c) =>
            c.type === ChannelType.GuildText &&
            (c.name.includes("general") ||
              c.name.includes("bot") ||
              c.name.includes("command"))
        );

        if (
          generalChannel &&
          generalChannel
            .permissionsFor(botMember)
            .has(PermissionFlagsBits.SendMessages)
        ) {
          const errorEmbed = new EmbedBuilder()
            .setColor("#ff0000")
            .setTitle("❌ Bot Missing Permissions")
            .setDescription(
              `I need the following permissions to create dungeons:\n• Manage Channels\n• Connect\n• Move Members\n\nPlease ask an administrator to grant these permissions.`
            )
            .setTimestamp();

          await generalChannel.send({ embeds: [errorEmbed] });
        }
        return;
      }

      // Find or create dungeons category
      let category = guild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildCategory &&
          c.name === this.config.dungeonCategoryName
      );

      if (!category) {
        try {
          category = await guild.channels.create({
            name: this.config.dungeonCategoryName,
            type: ChannelType.GuildCategory,
            position: 0,
          });
          console.log(
            `✅ Created category: ${this.config.dungeonCategoryName}`
          );
        } catch (categoryError) {
          console.log(`⚠️ Could not create category, using no parent instead`);
          category = null;
        }
      }

      // Create voice channel
      const channelData = {
        name: `${member.displayName}'s Dungeon`,
        type: ChannelType.GuildVoice,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
            ],
          },
          {
            id: member.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.MoveMembers,
            ],
          },
        ],
      };

      // Only add parent if category exists
      if (category) {
        channelData.parent = category.id;
      }

      const voiceChannel = await guild.channels.create(channelData);

      // Move user to their new dungeon
      if (member.voice.channel) {
        await member.voice.setChannel(voiceChannel);
      }

      // Store dungeon data
      this.dungeons.set(voiceChannel.id, {
        ownerId: member.id,
        ownerName: member.displayName,
        createdAt: Date.now(),
        isLocked: false,
        userLimit: null,
        invitedUsers: new Set(),
      });

      // Send welcome message to a suitable text channel
      const embed = new EmbedBuilder()
        .setColor("#00ff00")
        .setTitle("🏰 Dungeon Created Successfully!")
        .setDescription(
          `**${member.displayName}** has created a dungeon: **${voiceChannel.name}**\n\nJoin the voice channel and use \`${this.config.prefix}help\` in any text channel to see available commands.`
        )
        .setFooter({
          text: "Dungeon will auto-delete after 2 minutes of inactivity",
        })
        .setTimestamp();

      // Try to find a suitable text channel to send the welcome message
      const textChannels = guild.channels.cache.filter(
        (c) =>
          c.type === ChannelType.GuildText &&
          c
            .permissionsFor(botMember)
            .has([
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.EmbedLinks,
            ])
      );

      const suitableChannel =
        textChannels.find(
          (c) =>
            c.name.includes("general") ||
            c.name.includes("bot") ||
            c.name.includes("command")
        ) || textChannels.first();

      if (suitableChannel) {
        await suitableChannel.send({ embeds: [embed] });
      }

      console.log(
        `✅ Created dungeon: ${voiceChannel.name} for ${member.displayName}`
      );
    } catch (error) {
      console.error("❌ Error creating dungeon:", error.message);

      // Send user-friendly error message
      const errorChannel = guild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildText &&
          c
            .permissionsFor(guild.members.cache.get(this.client.user.id))
            ?.has(PermissionFlagsBits.SendMessages)
      );

      if (errorChannel) {
        const errorEmbed = new EmbedBuilder()
          .setColor("#ff0000")
          .setTitle("❌ Failed to Create Dungeon")
          .setDescription(
            `Sorry ${member.displayName}, I couldn't create your dungeon. Please contact an administrator to check my permissions.`
          )
          .setTimestamp();

        try {
          await errorChannel.send({ embeds: [errorEmbed] });
        } catch (msgError) {
          console.error("Could not send error message:", msgError.message);
        }
      }
    }
  }

  async checkDungeonEmpty(voiceChannel) {
    if (voiceChannel.members.size === 0) {
      // Start deletion timer
      const timerId = setTimeout(() => {
        this.deleteDungeon(voiceChannel.id);
      }, this.config.inactivityTimeout);

      this.deletionTimers.set(voiceChannel.id, timerId);
      console.log(
        `⏱️ Started deletion timer for empty dungeon: ${voiceChannel.name}`
      );
    }
  }

  cancelDeletionTimer(channelId) {
    if (this.deletionTimers.has(channelId)) {
      clearTimeout(this.deletionTimers.get(channelId));
      this.deletionTimers.delete(channelId);
      console.log(`⏹️ Cancelled deletion timer for dungeon: ${channelId}`);
    }
  }

  async deleteDungeon(channelId) {
    try {
      const channel = this.client.channels.cache.get(channelId);
      if (channel) {
        const dungeonData = this.dungeons.get(channelId);
        console.log(`🗑️ Auto-deleting empty dungeon: ${channel.name}`);

        await channel.delete("Dungeon auto-deleted due to inactivity");

        this.dungeons.delete(channelId);
        this.deletionTimers.delete(channelId);
      }
    } catch (error) {
      console.error("Error deleting dungeon:", error);
    }
  }

  async handleMessage(message) {
    // Ignore bot messages
    if (message.author.bot) return;

    // Check if message starts with prefix
    if (!message.content.startsWith(this.config.prefix)) return;

    console.log(
      `📝 Command received: ${message.content} from ${message.author.displayName}`
    );

    // Get the member who sent the message
    const member = message.guild.members.cache.get(message.author.id);

    // Check if user is in a voice channel
    if (!member.voice.channel) {
      console.log(`❌ User ${message.author.displayName} not in voice channel`);
      return this.sendErrorMessage(
        message.channel,
        "You must be in a dungeon voice channel to use dungeon commands."
      );
    }

    const voiceChannel = member.voice.channel;
    console.log(
      `🎙️ User in voice channel: ${voiceChannel.name} (ID: ${voiceChannel.id})`
    );

    // Check if the voice channel is a dungeon
    if (!this.dungeons.has(voiceChannel.id)) {
      console.log(
        `❌ Voice channel ${voiceChannel.name} is not a tracked dungeon`
      );
      console.log(`🗂️ Current dungeons:`, Array.from(this.dungeons.keys()));
      return this.sendErrorMessage(
        message.channel,
        `The voice channel "${voiceChannel.name}" is not a dungeon. Commands only work in dungeon voice channels.`
      );
    }

    console.log(
      `✅ Valid dungeon command from ${message.author.displayName} in ${voiceChannel.name}`
    );

    const args = message.content
      .slice(this.config.prefix.length)
      .trim()
      .split(/ +/);
    const command = args.shift().toLowerCase();

    console.log(`🎯 Executing command: ${command} with args:`, args);

    await this.executeCommand(message, command, args, voiceChannel);
  }

  async executeCommand(message, command, args, voiceChannel) {
    const dungeonData = this.dungeons.get(voiceChannel.id);
    const isOwner = message.author.id === dungeonData.ownerId;
    const member = message.guild.members.cache.get(message.author.id);

    console.log(
      `🎮 Executing command "${command}" - Owner: ${isOwner} - User: ${message.author.displayName}`
    );

    try {
      switch (command) {
        case "help":
          console.log("📋 Sending help message");
          await this.sendHelpMessage(message.channel);
          break;

        case "owner":
          console.log("👑 Showing owner info");
          await this.showOwner(message.channel, dungeonData);
          break;

        case "claim":
          console.log("🏰 Processing claim command");
          await this.claimDungeon(message, voiceChannel, dungeonData, member);
          break;

        case "lock":
          if (!isOwner) {
            console.log("❌ Non-owner tried to lock");
            return this.sendErrorMessage(
              message.channel,
              "Only the dungeon owner can lock the dungeon."
            );
          }
          console.log("🔒 Locking dungeon");
          await this.lockDungeon(message.channel, voiceChannel, dungeonData);
          break;

        case "unlock":
          if (!isOwner) {
            console.log("❌ Non-owner tried to unlock");
            return this.sendErrorMessage(
              message.channel,
              "Only the dungeon owner can unlock the dungeon."
            );
          }
          console.log("🔓 Unlocking dungeon");
          await this.unlockDungeon(message.channel, voiceChannel, dungeonData);
          break;

        case "invite":
          if (!isOwner) {
            console.log("❌ Non-owner tried to invite");
            return this.sendErrorMessage(
              message.channel,
              "Only the dungeon owner can invite users."
            );
          }
          console.log("📨 Processing invite");
          await this.inviteUser(message, args, voiceChannel, dungeonData);
          break;

        case "kick":
          if (!isOwner) {
            console.log("❌ Non-owner tried to kick");
            return this.sendErrorMessage(
              message.channel,
              "Only the dungeon owner can kick users."
            );
          }
          console.log("👢 Processing kick");
          await this.kickUser(message, args, voiceChannel);
          break;

        case "limit":
          if (!isOwner) {
            console.log("❌ Non-owner tried to set limit");
            return this.sendErrorMessage(
              message.channel,
              "Only the dungeon owner can set user limits."
            );
          }
          console.log("👥 Setting user limit");
          await this.setUserLimit(
            message.channel,
            args,
            voiceChannel,
            dungeonData
          );
          break;

        case "rename":
          if (!isOwner) {
            console.log("❌ Non-owner tried to rename");
            return this.sendErrorMessage(
              message.channel,
              "Only the dungeon owner can rename the dungeon."
            );
          }
          console.log("✏️ Renaming dungeon");
          await this.renameDungeon(
            message.channel,
            args,
            voiceChannel,
            dungeonData
          );
          break;

        case "end":
          if (!isOwner) {
            console.log("❌ Non-owner tried to end");
            return this.sendErrorMessage(
              message.channel,
              "Only the dungeon owner can end the dungeon."
            );
          }
          console.log("🏁 Ending dungeon");
          await this.endDungeon(message.channel, voiceChannel);
          break;

        default:
          console.log(`❓ Unknown command: ${command}`);
          await this.sendErrorMessage(
            message.channel,
            `Unknown command: \`${command}\`. Use \`${this.config.prefix}help\` for available commands.`
          );
      }
    } catch (error) {
      console.error("❌ Error executing command:", error);
      await this.sendErrorMessage(
        message.channel,
        "An error occurred while executing the command."
      );
    }
  }

  async sendHelpMessage(channel) {
    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("🏰 Dungeon Commands Help")
      .setDescription(`**Prefix:** \`${this.config.prefix}\``)
      .addFields(
        {
          name: "📋 General Commands",
          value:
            "`help` - Show this help message\n`owner` - Display current dungeon owner\n`claim` - Claim an empty dungeon",
          inline: false,
        },
        {
          name: "👑 Owner Only Commands",
          value:
            "`lock` - Lock dungeon from public access\n`unlock` - Unlock dungeon for anyone to join\n`invite @user` - Allow a user to join locked dungeon\n`kick @user` - Disconnect a user from dungeon\n`limit X` - Set max number of users (1-99)\n`rename New Name` - Rename the dungeon\n`end` - Delete your dungeon manually",
          inline: false,
        }
      )
      .setFooter({
        text: "Commands only work in this dungeon's voice channel chat",
      })
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  }

  async showOwner(channel, dungeonData) {
    const embed = new EmbedBuilder()
      .setColor("#gold")
      .setTitle("👑 Dungeon Owner")
      .setDescription(`**${dungeonData.ownerName}** owns this dungeon`)
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  }

  async claimDungeon(message, voiceChannel, dungeonData, member) {
    if (voiceChannel.members.size > 0) {
      return this.sendErrorMessage(
        message.channel,
        "Cannot claim a dungeon that has users in it."
      );
    }

    // Update dungeon ownership
    dungeonData.ownerId = member.id;
    dungeonData.ownerName = member.displayName;
    dungeonData.isLocked = false;
    dungeonData.invitedUsers.clear();

    // Update channel permissions
    await voiceChannel.permissionOverwrites.edit(member.id, {
      ViewChannel: true,
      Connect: true,
      ManageChannels: true,
      MoveMembers: true,
    });

    // Rename channel
    await voiceChannel.setName(`${member.displayName}'s Dungeon`);

    const embed = new EmbedBuilder()
      .setColor("#00ff00")
      .setTitle("👑 Dungeon Claimed!")
      .setDescription(`**${member.displayName}** has claimed this dungeon!`)
      .setTimestamp();

    await message.channel.send({ embeds: [embed] });
  }

  async lockDungeon(channel, voiceChannel, dungeonData) {
    dungeonData.isLocked = true;

    await voiceChannel.permissionOverwrites.edit(
      voiceChannel.guild.roles.everyone.id,
      {
        Connect: false,
      }
    );

    const embed = new EmbedBuilder()
      .setColor("#red")
      .setTitle("🔒 Dungeon Locked")
      .setDescription(
        "This dungeon is now locked. Only invited users can join."
      )
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  }

  async unlockDungeon(channel, voiceChannel, dungeonData) {
    dungeonData.isLocked = false;

    await voiceChannel.permissionOverwrites.edit(
      voiceChannel.guild.roles.everyone.id,
      {
        Connect: true,
      }
    );

    const embed = new EmbedBuilder()
      .setColor("#00ff00")
      .setTitle("🔓 Dungeon Unlocked")
      .setDescription("This dungeon is now unlocked. Anyone can join.")
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  }

  async inviteUser(message, args, voiceChannel, dungeonData) {
    const userMention = args[0];
    if (!userMention) {
      return this.sendErrorMessage(
        message.channel,
        "Please mention a user to invite. Example: `.d invite @username`"
      );
    }

    const userId = userMention.replace(/[<@!>]/g, "");
    const user = message.guild.members.cache.get(userId);

    if (!user) {
      return this.sendErrorMessage(message.channel, "User not found.");
    }

    dungeonData.invitedUsers.add(userId);

    await voiceChannel.permissionOverwrites.edit(userId, {
      Connect: true,
    });

    const embed = new EmbedBuilder()
      .setColor("#00ff00")
      .setTitle("📨 User Invited")
      .setDescription(
        `**${user.displayName}** has been invited to the dungeon!`
      )
      .setTimestamp();

    await message.channel.send({ embeds: [embed] });
  }

  async kickUser(message, args, voiceChannel) {
    const userMention = args[0];
    if (!userMention) {
      return this.sendErrorMessage(
        message.channel,
        "Please mention a user to kick. Example: `.d kick @username`"
      );
    }

    const userId = userMention.replace(/[<@!>]/g, "");
    const member = voiceChannel.members.get(userId);

    if (!member) {
      return this.sendErrorMessage(
        message.channel,
        "User not found in this voice channel."
      );
    }

    await member.voice.disconnect();

    const embed = new EmbedBuilder()
      .setColor("#ff9900")
      .setTitle("👢 User Kicked")
      .setDescription(
        `**${member.displayName}** has been kicked from the dungeon.`
      )
      .setTimestamp();

    await message.channel.send({ embeds: [embed] });
  }

  async setUserLimit(channel, args, voiceChannel, dungeonData) {
    const limit = parseInt(args[0]);

    if (isNaN(limit) || limit < 0 || limit > 99) {
      return this.sendErrorMessage(
        channel,
        "Please provide a valid number between 0-99. Use 0 for no limit."
      );
    }

    await voiceChannel.setUserLimit(limit);
    dungeonData.userLimit = limit === 0 ? null : limit;

    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("👥 User Limit Updated")
      .setDescription(
        `User limit set to: **${limit === 0 ? "No limit" : limit}**`
      )
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  }

  async renameDungeon(channel, args, voiceChannel, dungeonData) {
    const newName = args.join(" ");

    if (!newName) {
      return this.sendErrorMessage(
        channel,
        "Please provide a new name for the dungeon."
      );
    }

    if (newName.length > 100) {
      return this.sendErrorMessage(
        channel,
        "Dungeon name must be 100 characters or less."
      );
    }

    await voiceChannel.setName(newName);

    const embed = new EmbedBuilder()
      .setColor("#0099ff")
      .setTitle("✏️ Dungeon Renamed")
      .setDescription(`Dungeon renamed to: **${newName}**`)
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  }

  async endDungeon(channel, voiceChannel) {
    const embed = new EmbedBuilder()
      .setColor("#ff0000")
      .setTitle("🏁 Dungeon Ended")
      .setDescription("This dungeon has been manually ended by the owner.")
      .setTimestamp();

    await channel.send({ embeds: [embed] });

    setTimeout(() => {
      this.deleteDungeon(voiceChannel.id);
    }, 3000); // 3 second delay to show message
  }

  async sendErrorMessage(channel, message) {
    const embed = new EmbedBuilder()
      .setColor("#ff0000")
      .setTitle("❌ Error")
      .setDescription(message)
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  }

  start() {
    const token = process.env.DISCORD_BOT_TOKEN;

    if (!token) {
      console.error(
        "❌ ERROR: DISCORD_BOT_TOKEN not found in environment variables!"
      );
      console.error(
        "📝 Please check your .env file and make sure it contains:"
      );
      console.error("   DISCORD_BOT_TOKEN=your_actual_bot_token_here");
      process.exit(1);
    }

    if (token === "your_bot_token_here") {
      console.error(
        '❌ ERROR: Please replace "your_bot_token_here" with your actual Discord bot token!'
      );
      console.error(
        "📝 Get your token from: https://discord.com/developers/applications"
      );
      process.exit(1);
    }

    console.log("🔑 Attempting to login with bot token...");
    this.client.login(token).catch((error) => {
      console.error("❌ Failed to login to Discord:", error.message);
      console.error("📝 Please verify your bot token is correct and valid.");
      process.exit(1);
    });
  }
}

// Create and start the bot
const bot = new YourDungeonBot();
bot.start();

module.exports = YourDungeonBot;
