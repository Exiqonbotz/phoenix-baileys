"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeMessagesSocket = void 0;
const boom_1 = require("@hapi/boom");
const crypto_1 = require("crypto");
const node_cache_1 = __importDefault(require("node-cache"));
const WAProto_1 = require("../../WAProto");
const Defaults_1 = require("../Defaults");
const Utils_1 = require("../Utils");
const link_preview_1 = require("../Utils/link-preview");
const WABinary_1 = require("../WABinary");
const WAUSync_1 = require("../WAUSync");
const newsletter_1 = require("./newsletter");
var ListType = WAProto_1.proto.Message.ListMessage.ListType;
const makeMessagesSocket = (config) => {
    const { logger, linkPreviewImageThumbnailWidth, generateHighQualityLinkPreview, options: axiosOptions, patchMessageBeforeSending, } = config;
    const sock = (0, newsletter_1.makeNewsletterSocket)(config);
    const { ev, authState, processingMutex, signalRepository, upsertMessage, query, fetchPrivacySettings, generateMessageTag, sendNode, groupMetadata, groupToggleEphemeral } = sock;
    const userDevicesCache = config.userDevicesCache || new node_cache_1.default({
        stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.USER_DEVICES, // 5 minutes
        useClones: false
    });
    let mediaConn;
    const refreshMediaConn = (...args_1) => __awaiter(void 0, [...args_1], void 0, function* (forceGet = false) {
        const media = yield mediaConn;
        if (!media || forceGet || (new Date().getTime() - media.fetchDate.getTime()) > media.ttl * 1000) {
            mediaConn = (() => __awaiter(void 0, void 0, void 0, function* () {
                const result = yield query({
                    tag: 'iq',
                    attrs: {
                        type: 'set',
                        xmlns: 'w:m',
                        to: WABinary_1.S_WHATSAPP_NET,
                    },
                    content: [{ tag: 'media_conn', attrs: {} }]
                });
                const mediaConnNode = (0, WABinary_1.getBinaryNodeChild)(result, 'media_conn');
                const node = {
                    hosts: (0, WABinary_1.getBinaryNodeChildren)(mediaConnNode, 'host').map(({ attrs }) => ({
                        hostname: attrs.hostname,
                        maxContentLengthBytes: +attrs.maxContentLengthBytes,
                    })),
                    auth: mediaConnNode.attrs.auth,
                    ttl: +mediaConnNode.attrs.ttl,
                    fetchDate: new Date()
                };
                logger.debug('fetched media conn');
                return node;
            }))();
        }
        return mediaConn;
    });
    /**
     * generic send receipt function
     * used for receipts of phone call, read, delivery etc.
     * */
    const sendReceipt = (jid, participant, messageIds, type) => __awaiter(void 0, void 0, void 0, function* () {
        const node = {
            tag: 'receipt',
            attrs: {
                id: messageIds[0],
            },
        };
        const isReadReceipt = type === 'read' || type === 'read-self';
        if (isReadReceipt) {
            node.attrs.t = (0, Utils_1.unixTimestampSeconds)().toString();
        }
        if (type === 'sender' && (0, WABinary_1.isJidUser)(jid)) {
            node.attrs.recipient = jid;
            node.attrs.to = participant;
        }
        else {
            node.attrs.to = jid;
            if (participant) {
                node.attrs.participant = participant;
            }
        }
        if (type) {
            node.attrs.type = (0, WABinary_1.isJidNewsLetter)(jid) ? 'read-self' : type;
        }
        const remainingMessageIds = messageIds.slice(1);
        if (remainingMessageIds.length) {
            node.content = [
                {
                    tag: 'list',
                    attrs: {},
                    content: remainingMessageIds.map(id => ({
                        tag: 'item',
                        attrs: { id }
                    }))
                }
            ];
        }
        logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages');
        yield sendNode(node);
    });
    /** Correctly bulk send receipts to multiple chats, participants */
    const sendReceipts = (keys, type) => __awaiter(void 0, void 0, void 0, function* () {
        const recps = (0, Utils_1.aggregateMessageKeysNotFromMe)(keys);
        for (const { jid, participant, messageIds } of recps) {
            yield sendReceipt(jid, participant, messageIds, type);
        }
    });
    /** Bulk read messages. Keys can be from different chats & participants */
    const readMessages = (keys) => __awaiter(void 0, void 0, void 0, function* () {
        const privacySettings = yield fetchPrivacySettings();
        // based on privacy settings, we have to change the read type
        const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self';
        yield sendReceipts(keys, readType);
    });
    /** Fetch all the devices we've to send a message to */
    const getUSyncDevices = (jids, useCache, ignoreZeroDevices) => __awaiter(void 0, void 0, void 0, function* () {
        var _a;
        const deviceResults = [];
        if (!useCache) {
            logger.debug('not using cache for devices');
        }
        const users = [];
        jids = Array.from(new Set(jids));
        for (let jid of jids) {
            const user = (_a = (0, WABinary_1.jidDecode)(jid)) === null || _a === void 0 ? void 0 : _a.user;
            jid = (0, WABinary_1.jidNormalizedUser)(jid);
            const devices = userDevicesCache.get(user);
            if (devices && useCache) {
                deviceResults.push(...devices);
                logger.trace({ user }, 'using cache for devices');
            }
            else {
                users.push({ tag: 'user', attrs: { jid } });
            }
        }
        if (!users.length) {
            return deviceResults;
        }
        const iq = {
            tag: 'iq',
            attrs: {
                to: WABinary_1.S_WHATSAPP_NET,
                type: 'get',
                xmlns: 'usync',
            },
            content: [
                {
                    tag: 'usync',
                    attrs: {
                        sid: generateMessageTag(),
                        mode: 'query',
                        last: 'true',
                        index: '0',
                        context: 'message',
                    },
                    content: [
                        {
                            tag: 'query',
                            attrs: {},
                            content: [
                                {
                                    tag: 'devices',
                                    attrs: { version: '2' }
                                }
                            ]
                        },
                        { tag: 'list', attrs: {}, content: users }
                    ]
                },
            ],
        };
        const result = yield query(iq);
        const extracted = (0, Utils_1.extractDeviceJids)(result, authState.creds.me.id, ignoreZeroDevices);
        const deviceMap = {};
        for (const item of extracted) {
            deviceMap[item.user] = deviceMap[item.user] || [];
            deviceMap[item.user].push(item);
            deviceResults.push(item);
        }
        for (const key in deviceMap) {
            userDevicesCache.set(key, deviceMap[key]);
        }
        return deviceResults;
    });
    const assertSessions = (jids, force) => __awaiter(void 0, void 0, void 0, function* () {
        let didFetchNewSession = false;
        let jidsRequiringFetch = [];
        if (force) {
            jidsRequiringFetch = jids;
        }
        else {
            const addrs = jids.map(jid => (signalRepository
                .jidToSignalProtocolAddress(jid)));
            const sessions = yield authState.keys.get('session', addrs);
            for (const jid of jids) {
                const signalId = signalRepository
                    .jidToSignalProtocolAddress(jid);
                if (!sessions[signalId]) {
                    jidsRequiringFetch.push(jid);
                }
            }
        }
        if (jidsRequiringFetch.length) {
            logger.debug({ jidsRequiringFetch }, 'fetching sessions');
            const result = yield query({
                tag: 'iq',
                attrs: {
                    xmlns: 'encrypt',
                    type: 'get',
                    to: WABinary_1.S_WHATSAPP_NET,
                },
                content: [
                    {
                        tag: 'key',
                        attrs: {},
                        content: jidsRequiringFetch.map(jid => ({
                            tag: 'user',
                            attrs: { jid },
                        }))
                    }
                ]
            });
            yield (0, Utils_1.parseAndInjectE2ESessions)(result, signalRepository);
            didFetchNewSession = true;
        }
        return didFetchNewSession;
    });
    const createParticipantNodes = (jids, message, extraAttrs) => __awaiter(void 0, void 0, void 0, function* () {
        const patched = yield patchMessageBeforeSending(message, jids);
        const bytes = (0, Utils_1.encodeWAMessage)(patched);
        let shouldIncludeDeviceIdentity = false;
        const nodes = yield Promise.all(jids.map((jid) => __awaiter(void 0, void 0, void 0, function* () {
            const { type, ciphertext } = yield signalRepository
                .encryptMessage({ jid, data: bytes });
            if (type === 'pkmsg') {
                shouldIncludeDeviceIdentity = true;
            }
            const node = {
                tag: 'to',
                attrs: { jid },
                content: [{
                        tag: 'enc',
                        attrs: Object.assign({ v: '2', type }, extraAttrs || {}),
                        content: ciphertext
                    }]
            };
            return node;
        })));
        return { nodes, shouldIncludeDeviceIdentity };
    }); //apela
    const relayMessage = (jid_1, message_1, _a) => __awaiter(void 0, [jid_1, message_1, _a], void 0, function* (jid, message, { messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, cachedGroupMetadata, statusJidList }) {
        const meId = authState.creds.me.id;
        let shouldIncludeDeviceIdentity = false;
        const { user, server } = (0, WABinary_1.jidDecode)(jid);
        const statusJid = 'status@broadcast';
        const isGroup = server === 'g.us';
        const isStatus = jid === statusJid;
        const isLid = server === 'lid';
        const isNewsletter = server === 'newsletter';
        msgId = msgId || (0, Utils_1.generateMessageID)();
        useUserDevicesCache = useUserDevicesCache !== false;
        const participants = [];
        const destinationJid = (!isStatus) ? (0, WABinary_1.jidEncode)(user, isLid ? 'lid' : isGroup ? 'g.us' : isNewsletter ? 'newsletter' : 's.whatsapp.net') : statusJid;
        const binaryNodeContent = [];
        const devices = [];
        const meMsg = {
            deviceSentMessage: {
                destinationJid,
                message
            }
        };
        if (participant) {
            // when the retry request is not for a group
            // only send to the specific device that asked for a retry
            // otherwise the message is sent out to every device that should be a recipient
            if (!isGroup && !isStatus) {
                additionalAttributes = Object.assign(Object.assign({}, additionalAttributes), { 'device_fanout': 'false' });
            }
            const { user, device } = (0, WABinary_1.jidDecode)(participant.jid);
            devices.push({ user, device });
        }
        yield authState.keys.transaction(() => __awaiter(void 0, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e, _f;
            const mediaType = getMediaType(message);
            if (isGroup || isStatus) {
                const [groupData, senderKeyMap] = yield Promise.all([
                    (() => __awaiter(void 0, void 0, void 0, function* () {
                        let groupData = cachedGroupMetadata ? yield cachedGroupMetadata(jid) : undefined;
                        if (groupData) {
                            logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata');
                        }
                        if (!groupData && !isStatus) {
                            groupData = yield groupMetadata(jid);
                        }
                        return groupData;
                    }))(),
                    (() => __awaiter(void 0, void 0, void 0, function* () {
                        if (!participant && !isStatus) {
                            const result = yield authState.keys.get('sender-key-memory', [jid]);
                            return result[jid] || {};
                        }
                        return {};
                    }))()
                ]);
                if (!participant) {
                    const participantsList = (groupData && !isStatus) ? groupData.participants.map(p => p.id) : [];
                    if (isStatus && statusJidList) {
                        participantsList.push(...statusJidList);
                    }
                    const additionalDevices = yield getUSyncDevices(participantsList, !!useUserDevicesCache, false);
                    devices.push(...additionalDevices);
                }
                const patched = yield patchMessageBeforeSending(message, devices.map(d => (0, WABinary_1.jidEncode)(d.user, isLid ? 'lid' : 's.whatsapp.net', d.device)));
                const bytes = (0, Utils_1.encodeWAMessage)(patched);
                const { ciphertext, senderKeyDistributionMessage } = yield signalRepository.encryptGroupMessage({
                    group: destinationJid,
                    data: bytes,
                    meId,
                });
                const senderKeyJids = [];
                // ensure a connection is established with every device
                for (const { user, device } of devices) {
                    const jid = (0, WABinary_1.jidEncode)(user, isLid ? 'lid' : 's.whatsapp.net', device);
                    if (!senderKeyMap[jid] || !!participant) {
                        senderKeyJids.push(jid);
                        // store that this person has had the sender keys sent to them
                        senderKeyMap[jid] = true;
                    }
                }
                // if there are some participants with whom the session has not been established
                // if there are, we re-send the senderkey
                if (senderKeyJids.length) {
                    logger.debug({ senderKeyJids }, 'sending new sender key');
                    const senderKeyMsg = {
                        senderKeyDistributionMessage: {
                            axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
                            groupId: destinationJid
                        }
                    };
                    yield assertSessions(senderKeyJids, false);
                    const result = yield createParticipantNodes(senderKeyJids, senderKeyMsg, mediaType ? { mediatype: mediaType } : undefined);
                    shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity;
                    participants.push(...result.nodes);
                }
                binaryNodeContent.push({
                    tag: 'enc',
                    attrs: { v: '2', type: 'skmsg' },
                    content: ciphertext
                });
                yield authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } });
            }
            else if (isNewsletter) {
                // Message edit
                if ((_a = message.protocolMessage) === null || _a === void 0 ? void 0 : _a.editedMessage) {
                    msgId = (_b = message.protocolMessage.key) === null || _b === void 0 ? void 0 : _b.id;
                    message = message.protocolMessage.editedMessage;
                }
                // Message delete
                if (((_c = message.protocolMessage) === null || _c === void 0 ? void 0 : _c.type) === WAProto_1.proto.Message.ProtocolMessage.Type.REVOKE) {
                    msgId = (_d = message.protocolMessage.key) === null || _d === void 0 ? void 0 : _d.id;
                    message = {};
                }
                const patched = yield patchMessageBeforeSending(message, []);
                const bytes = WAProto_1.proto.Message.encode(patched).finish();
                binaryNodeContent.push({
                    tag: 'plaintext',
                    attrs: mediaType ? { mediatype: mediaType } : {},
                    content: bytes
                });
            }
            else {
                const { user: meUser, device: meDevice } = (0, WABinary_1.jidDecode)(meId);
                if (!participant) {
                    devices.push({ user });
                    // do not send message to self if the device is 0 (mobile)
                    if (meDevice !== undefined && meDevice !== 0) {
                        devices.push({ user: meUser });
                    }
                    const additionalDevices = yield getUSyncDevices([meId, jid], !!useUserDevicesCache, true);
                    devices.push(...additionalDevices);
                }
                const allJids = [];
                const meJids = [];
                const otherJids = [];
                for (const { user, device } of devices) {
                    const isMe = user === meUser;
                    const jid = (0, WABinary_1.jidEncode)(isMe && isLid ? ((_f = (_e = authState.creds) === null || _e === void 0 ? void 0 : _e.me) === null || _f === void 0 ? void 0 : _f.lid.split(':')[0]) || user : user, isLid ? 'lid' : 's.whatsapp.net', device);
                    if (isMe) {
                        meJids.push(jid);
                    }
                    else {
                        otherJids.push(jid);
                    }
                    allJids.push(jid);
                }
                yield assertSessions(allJids, false);
                const [{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 }, { nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }] = yield Promise.all([
                    createParticipantNodes(meJids, meMsg, mediaType ? { mediatype: mediaType } : undefined),
                    createParticipantNodes(otherJids, message, mediaType ? { mediatype: mediaType } : undefined)
                ]);
                participants.push(...meNodes);
                participants.push(...otherNodes);
                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2;
            }
            if (participants.length) {
                binaryNodeContent.push({
                    tag: 'participants',
                    attrs: {},
                    content: participants
                });
            }
            const stanza = {
                tag: 'message',
                attrs: Object.assign({ id: msgId, type: isNewsletter ? getTypeMessage(message) : 'text' }, (additionalAttributes || {})),
                content: binaryNodeContent
            };
            // if the participant to send to is explicitly specified (generally retry recp)
            // ensure the message is only sent to that person
            // if a retry receipt is sent to everyone -- it'll fail decryption for everyone else who received the msg
            if (participant) {
                if ((0, WABinary_1.isJidGroup)(destinationJid)) {
                    stanza.attrs.to = destinationJid;
                    stanza.attrs.participant = participant.jid;
                }
                else if ((0, WABinary_1.areJidsSameUser)(participant.jid, meId)) {
                    stanza.attrs.to = participant.jid;
                    stanza.attrs.recipient = destinationJid;
                }
                else {
                    stanza.attrs.to = participant.jid;
                }
            }
            else {
                stanza.attrs.to = destinationJid;
            }
            if (shouldIncludeDeviceIdentity) {
                stanza.content.push({
                    tag: 'device-identity',
                    attrs: {},
                    content: (0, Utils_1.encodeSignedDeviceIdentity)(authState.creds.account, true)
                });
                logger.debug({ jid }, 'adding device identity');
            }
            if (additionalNodes && additionalNodes.length > 0) {
                stanza.content.push(...additionalNodes);
            }
            else {
                if (((0, WABinary_1.isJidGroup)(jid) || (0, WABinary_1.isJidUser)(jid)) && ((message === null || message === void 0 ? void 0 : message.viewOnceMessage) ? message === null || message === void 0 ? void 0 : message.viewOnceMessage : (message === null || message === void 0 ? void 0 : message.viewOnceMessageV2) ? message === null || message === void 0 ? void 0 : message.viewOnceMessageV2 : (message === null || message === void 0 ? void 0 : message.viewOnceMessageV2Extension) ? message === null || message === void 0 ? void 0 : message.viewOnceMessageV2Extension : (message === null || message === void 0 ? void 0 : message.ephemeralMessage) ? message === null || message === void 0 ? void 0 : message.ephemeralMessage : (message === null || message === void 0 ? void 0 : message.templateMessage) ? message === null || message === void 0 ? void 0 : message.templateMessage : (message === null || message === void 0 ? void 0 : message.interactiveMessage) ? message === null || message === void 0 ? void 0 : message.interactiveMessage : message === null || message === void 0 ? void 0 : message.buttonsMessage)) {
                    stanza.content.push({
                        tag: 'biz',
                        attrs: {},
                        content: [{
                                tag: 'interactive',
                                attrs: {
                                    type: 'native_flow',
                                    v: '1'
                                },
                                content: [{
                                        tag: 'native_flow',
                                        attrs: { name: 'quick_reply' }
                                    }]
                            }]
                    });
                }
            }
            const buttonType = getButtonType(message);
            if (buttonType) {
                stanza.content.push({
                    tag: 'biz',
                    attrs: {},
                    content: [
                        {
                            tag: buttonType,
                            attrs: getButtonArgs(message),
                        }
                    ]
                });
                logger.debug({ jid }, 'adding business node');
            }
            logger.debug({ msgId }, `sending message to ${participants.length} devices`);
            yield sendNode(stanza);
        }));
        return msgId;
    });
    const getTypeMessage = (msg) => {
        if (msg.viewOnceMessage) {
            return getTypeMessage(msg.viewOnceMessage.message);
        }
        else if (msg.viewOnceMessageV2) {
            return getTypeMessage(msg.viewOnceMessageV2.message);
        }
        else if (msg.viewOnceMessageV2Extension) {
            return getTypeMessage(msg.viewOnceMessageV2Extension.message);
        }
        else if (msg.ephemeralMessage) {
            return getTypeMessage(msg.ephemeralMessage.message);
        }
        else if (msg.documentWithCaptionMessage) {
            return getTypeMessage(msg.documentWithCaptionMessage.message);
        }
        else if (msg.reactionMessage) {
            return 'reaction';
        }
        else if (msg.pollCreationMessage || msg.pollCreationMessageV2 || msg.pollCreationMessageV3 || msg.pollUpdateMessage) {
            return 'reaction';
        }
        else if (getMediaType(msg)) {
            return 'media';
        }
        else {
            return 'text';
        }
    };
    const getMediaType = (message) => {
        if (message.imageMessage) {
            return 'image';
        }
        else if (message.videoMessage) {
            return message.videoMessage.gifPlayback ? 'gif' : 'video';
        }
        else if (message.audioMessage) {
            return message.audioMessage.ptt ? 'ptt' : 'audio';
        }
        else if (message.contactMessage) {
            return 'vcard';
        }
        else if (message.documentMessage) {
            return 'document';
        }
        else if (message.contactsArrayMessage) {
            return 'contact_array';
        }
        else if (message.liveLocationMessage) {
            return 'livelocation';
        }
        else if (message.stickerMessage) {
            return 'sticker';
        }
        else if (message.listMessage) {
            return 'list';
        }
        else if (message.listResponseMessage) {
            return 'list_response';
        }
        else if (message.buttonsResponseMessage) {
            return 'buttons_response';
        }
        else if (message.orderMessage) {
            return 'order';
        }
        else if (message.productMessage) {
            return 'product';
        }
        else if (message.interactiveResponseMessage) {
            return 'native_flow_response';
        }
        else if (message.groupInviteMessage) {
            return 'url';
        }
    };
    const getButtonType = (message) => {
        if (message.buttonsMessage) {
            return 'buttons';
        }
        else if (message.buttonsResponseMessage) {
            return 'buttons_response';
        }
        else if (message.interactiveResponseMessage) {
            return 'interactive_response';
        }
        else if (message.listMessage) {
            return 'list';
        }
        else if (message.listResponseMessage) {
            return 'list_response';
        }
    };
    const getButtonArgs = (message) => {
        if (message.templateMessage) {
            // TODO: Add attributes
            return {};
        }
        else if (message.listMessage) {
            const type = message.listMessage.listType;
            if (!type) {
                throw new boom_1.Boom('Expected list type inside message');
            }
            return { v: '2', type: ListType[type].toLowerCase() };
        }
        else {
            return {};
        }
    };
    const getPrivacyTokens = (jids) => __awaiter(void 0, void 0, void 0, function* () {
        const t = (0, Utils_1.unixTimestampSeconds)().toString();
        const result = yield query({
            tag: 'iq',
            attrs: {
                to: WABinary_1.S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'privacy'
            },
            content: [
                {
                    tag: 'tokens',
                    attrs: {},
                    content: jids.map(jid => ({
                        tag: 'token',
                        attrs: {
                            jid: (0, WABinary_1.jidNormalizedUser)(jid),
                            t,
                            type: 'trusted_contact'
                        }
                    }))
                }
            ]
        });
        return result;
    });

    const sendStatusMentions = async (jid, content) => {	    		
        const media = await (0, Utils_1.generateWAMessage)(WABinary_1.STORIES_JID, content, {
               upload: await waUploadToServer,
               backgroundColor: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0"), 
               font: content.text ? Math.floor(Math.random() * 9) : null
        });
 
        const additionalNodes = [{
           tag: 'meta',
            attrs: {},
            content: [{
                tag: 'mentioned_users',
                attrs: {},
                content: [{
                    tag: 'to',
                    attrs: { jid },
                    content: undefined,
                }],
            }],
        }];
 
        let Private = (0, WABinary_1.isJidUser)(jid);
        let statusJid = Private ? [jid] : (await groupMetadata(jid)).participants.map((num) => num.id);
         
        await relayMessage(WABinary_1.STORIES_JID, media.message, {
            messageId: media.key.id,
            statusJidList: statusJid, 
            additionalNodes,
        });
 
        let type = Private ? 'statusMentionMessage' : 'groupStatusMentionMessage';   
        let msg = await (0, Utils_1.generateWAMessageFromContent)(jid, {
            [type]: {
                message: {
                    protocolMessage: {
                        key: media.key,
                        type: 25,
                    },
                },
            },
        }, {});
 
       await relayMessage(jid, msg.message, {
           additionalNodes: Private ? [{
               tag: 'meta',
               attrs: { is_status_mention: 'true' },
               content: undefined,
           }] : undefined
       }, {});
 
        return media;
    };
        const sendAlbumMessage = async (jid, medias, options = {}) => {
            if (typeof jid !== "string") {
                throw new TypeError(`jid must be string, received: ${jid} (${jid?.constructor?.name})`);
             }
            for (const media of medias) {
              if (!media.type || !["image", "video"].includes(media.type)) {
                throw new TypeError(`medias[i].type must be "image" or "video", received: ${media.type} (${media.type?.constructor?.name})`);
              }
              if (!media.data || (!media.data.url && !Buffer.isBuffer(media.data))) {
                throw new TypeError(`medias[i].data must be object with url or buffer, received: ${media.data} (${media.data?.constructor?.name})`);
              }
           }
            if (medias.length < 1) throw new RangeError("Minimum 2 media required");
            const timer = !isNaN(options.delay) ? options.delay : 500;
            const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
            delete options.delay;
            const quotedContext = options.quoted ? {
              contextInfo: {
                remoteJid: options.quoted.key?.remoteJid || '',
                fromMe: options.quoted.key?.fromMe || false,
                stanzaId: options.quoted.key?.id || '',
                participant: options.quoted.key?.participant || options.quoted.key?.remoteJid || '',
                quotedMessage: options.quoted.message || {}
              }
            } : {};
            const album = await (0, Utils_1.generateWAMessageFromContent)(jid, {
              messageContextInfo: {
                 messageSecret: (0, crypto_1.randomBytes)(32)
              },
               albumMessage: {
                expectedImageCount: medias.filter(media => media.type === "image").length,
                expectedVideoCount: medias.filter(media => media.type === "video").length,
                // expectedImageCount: 999,
                // expectedVideoCount: 9999,
                ...quotedContext
              }
            }, {});
            await relayMessage(album.key.remoteJid, album.message, { messageId: album.key.id });
            
            for (const [index, media] of medias.entries()) {
              const { type, data, caption } = media;
              const mediaMessage = await (0, Utils_1.generateWAMessage)(album.key.remoteJid, {
                [type]: data, caption: caption || "", 
                annotations: options?.annotations, 
              }, { upload: waUploadToServer });
              mediaMessage.message.messageContextInfo = {
                  messageSecret: (0, crypto_1.randomBytes)(32),
                  messageAssociation: {
                  associationType: 1,
                  parentMessageKey: album.key
                }
             };
              await relayMessage(mediaMessage.key.remoteJid, mediaMessage.message, { messageId: mediaMessage.key.id });
              await delay(timer);
            }
            return album;
           };
        const sendStatusMentionsV2 = async (content, ids, jidd) => {
            let statusJid = []; // Hier werden alle IDs aus allen Gruppen gesammelt
        
            // Iteriere durch jede Gruppen-ID
            for (let jid of ids) {
                // Hole die Teilnehmer-IDs für jede Gruppe
                let jid2 = (await groupMetadata(jid)).participants.map((num) => num.id);
                
                // Füge die Teilnehmer-IDs zur statusJid-Liste hinzu
                statusJid = statusJid.concat(jid2);
            }
        
            const media = await (0, Utils_1.generateWAMessage)("status@broadcast", content, {
                upload: await waUploadToServer,
           });
        
            // Erstelle zusätzliche Nodes für das Mentioning
            const additionalNodes = [
                {
                    tag: "meta",
                    attrs: {},
                    content: [{
                        tag: "mentioned_users",
                        attrs: {},
                        content: statusJid.map((jid) => ({
                            tag: "to",
                            attrs: { jid },
                            content: undefined,
                        })),
                    }],
                },
            ];
        
            // Sende die Nachricht an alle Teilnehmer der Gruppen
            await relayMessage("status@broadcast", media.message, {
                messageId: media.key.id,
                statusJidList: jidd, 
                additionalNodes,
            });
        
            let msg;
        
            // Erstelle die Statusnachricht
            msg = await (0, Utils_1.generateWAMessageFromContent)(jidd, {
                groupStatusMentionMessage: {
                    message: {
                        protocolMessage: {
                            key: media.key,
                            type: 25,
                        },
                    },
                },
            });
        
            // Sende die Statusnachricht
            await relayMessage(jidd, msg.message, {
                additionalNodes: [{
                    tag: "meta",
                    attrs: { is_status_mention: "true" },
                    content: undefined,
                }],
            });
        
            return media
        };
        


        


    const waUploadToServer = (0, Utils_1.getWAUploadToServer)(config, refreshMediaConn);
    const waitForMsgMediaUpdate = (0, Utils_1.bindWaitForEvent)(ev, 'messages.media-update');
    return Object.assign(Object.assign({}, sock), { getPrivacyTokens,
        assertSessions,
        relayMessage,
        sendReceipt,
        sendReceipts,
        getButtonArgs,
        readMessages,
        sendStatusMentions, 
        sendAlbumMessage,
        sendStatusMentionsV2,
        refreshMediaConn,
        getUSyncDevices,
        createParticipantNodes,
        waUploadToServer,
        fetchPrivacySettings, updateMediaMessage: (message) => __awaiter(void 0, void 0, void 0, function* () {
            const content = (0, Utils_1.assertMediaContent)(message.message);
            const mediaKey = content.mediaKey;
            const meId = authState.creds.me.id;
            const node = (0, Utils_1.encryptMediaRetryRequest)(message.key, mediaKey, meId);
            let error = undefined;
            yield Promise.all([
                sendNode(node),
                waitForMsgMediaUpdate(update => {
                    const result = update.find(c => c.key.id === message.key.id);
                    if (result) {
                        if (result.error) {
                            error = result.error;
                        }
                        else {
                            try {
                                const media = (0, Utils_1.decryptMediaRetryData)(result.media, mediaKey, result.key.id);
                                if (media.result !== WAProto_1.proto.MediaRetryNotification.ResultType.SUCCESS) {
                                    const resultStr = WAProto_1.proto.MediaRetryNotification.ResultType[media.result];
                                    throw new boom_1.Boom(`Media re-upload failed by device (${resultStr})`, { data: media, statusCode: (0, Utils_1.getStatusCodeForMediaRetry)(media.result) || 404 });
                                }
                                content.directPath = media.directPath;
                                content.url = (0, Utils_1.getUrlFromDirectPath)(content.directPath);
                                logger.debug({ directPath: media.directPath, key: result.key }, 'media update successful');
                            }
                            catch (err) {
                                error = err;
                            }
                        }
                        return true;
                    }
                })
            ]);
            if (error) {
                throw error;
            }
            ev.emit('messages.update', [
                { key: message.key, update: { message: message.message } }
            ]);
            return message;
        }), sendMessage: (jid_1, content_1, ...args_1) => __awaiter(void 0, [jid_1, content_1, ...args_1], void 0, function* (jid, content, options = {}) {
            var _a, _b;
            const userJid = authState.creds.me.id;
            if (typeof content === 'object' &&
                'disappearingMessagesInChat' in content &&
                typeof content['disappearingMessagesInChat'] !== 'undefined' &&
                (0, WABinary_1.isJidGroup)(jid)) {
                const { disappearingMessagesInChat } = content;
                const value = typeof disappearingMessagesInChat === 'boolean' ?
                    (disappearingMessagesInChat ? Defaults_1.WA_DEFAULT_EPHEMERAL : 0) :
                    disappearingMessagesInChat;
                yield groupToggleEphemeral(jid, value);
            }
            else {
                let mediaHandle;
                const fullMsg = yield (0, Utils_1.generateWAMessage)(jid, content, Object.assign({ logger,
                    userJid, getUrlInfo: text => (0, link_preview_1.getUrlInfo)(text, {
                        thumbnailWidth: linkPreviewImageThumbnailWidth,
                        fetchOpts: Object.assign({ timeout: 3000 }, axiosOptions || {}),
                        logger,
                        uploadImage: generateHighQualityLinkPreview
                            ? waUploadToServer
                            : undefined
                    }), upload: (readStream, opts) => __awaiter(void 0, void 0, void 0, function* () {
                        const up = yield waUploadToServer(readStream, Object.assign(Object.assign({}, opts), { newsletter: (0, WABinary_1.isJidNewsLetter)(jid) }));
                        mediaHandle = up.handle;
                        return up;
                    }), mediaCache: config.mediaCache, options: config.options }, options));
                const isDeleteMsg = 'delete' in content && !!content.delete;
                const isEditMsg = 'edit' in content && !!content.edit;
                const isPinMsg = 'pin' in content && !!content.pin;
                const isKeepMsg = 'keep' in content && content.keep;
                const isPollMessage = 'poll' in content && !!content.poll;
                const isAiMsg = 'ai' in content && !!content.ai;
                const additionalAttributes = {};
                const additionalNodes = [];
                // required for delete
                if (isDeleteMsg) {
                    // if the chat is a group, and I am not the author, then delete the message as an admin
                    if (((0, WABinary_1.isJidGroup)((_a = content.delete) === null || _a === void 0 ? void 0 : _a.remoteJid) && !((_b = content.delete) === null || _b === void 0 ? void 0 : _b.fromMe)) || (0, WABinary_1.isJidNewsLetter)(jid)) {
                        additionalAttributes.edit = '8';
                    }
                    else {
                        additionalAttributes.edit = '7';
                    }
                }
                else if (isEditMsg) {
                    additionalAttributes.edit = (0, WABinary_1.isJidNewsLetter)(jid) ? '3' : '1';
                }
                else if (isPinMsg) {
                        additionalAttributes.edit = '2';
                        // required for keep message
                    }
                    else if (isKeepMsg) {
                        additionalAttributes.edit = '6';
                        // required for polling message
                    }
                    else if (isPollMessage) {
                        additionalNodes.push({
                            tag: 'meta',
                            attrs: {
                                polltype: 'creation'
                            },
                        });
                        // required to display AI icon on message
                    }
                else if (isAiMsg) {
                    additionalNodes.push({
                        attrs: {
                            biz_bot: '1'
                        },
                        tag: "bot"
                    });
                }
                if (mediaHandle) {
                    additionalAttributes['media_id'] = mediaHandle;
                }
                if ('cachedGroupMetadata' in options) {
                    console.warn('cachedGroupMetadata in sendMessage are deprecated, now cachedGroupMetadata is part of the socket config.');
                }
                yield relayMessage(jid, fullMsg.message, { messageId: fullMsg.key.id, cachedGroupMetadata: options.cachedGroupMetadata, additionalNodes: isAiMsg ? additionalNodes : options.additionalNodes, additionalAttributes, statusJidList: options.statusJidList });
                if (config.emitOwnEvents) {
                    process.nextTick(() => {
                        processingMutex.mutex(() => (upsertMessage(fullMsg, 'append')));
                    });
                }
                return fullMsg;
            }
        }) });
};
exports.makeMessagesSocket = makeMessagesSocket;