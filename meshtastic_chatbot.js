import { Data, MeshPacket, ToRadio } from './gen/meshtastic/mesh_pb.js';

import { PortNum } from './gen/meshtastic/portnums_pb.js';

import { MeshtasticPacketHandler } from './meshtastic_packet_handler.js';

export class Session {
    attributes;

    constructor() {
        this.attributes = {};
    }

    async get(key, fallback=null) {
        if (typeof this.attributes[key] === "undefined") {
            if (fallback !== null) {
                const value = await fallback();
                this.set(key, value);
            }
        }

        return this.attributes[key];
    }

    async set(key, value) {
        this.attributes[key] = value;
    }
}

export class Context {
    me;
    stream;
    packet;
    message;
    session;

    constructor(me, stream, packet, message, session) {
        this.me = me;
        this.stream = stream;
        this.packet = packet;
        this.message = message;
        this.session = session;
    }

    async get(key, fallback=null) {
        return await this.session.get(key, fallback);
    }

    async set(key, value) {
        return await this.session.set(key, value);
    }

    async reply(text, in_reply_to=null) {
        while (Buffer.from(text, 'utf-8').byteLength > 228) {
            text = text.slice(0, -1);
        }

        const data = new Data();
        data.portnum = PortNum.TEXT_MESSAGE_APP;
        data.payload = Buffer.from(text, 'utf-8');
        if (in_reply_to !== null) {
            data.replyId = in_reply_to;
        }

        const reply = new MeshPacket();
        reply.channel = this.packet.channel;
        reply.from = this.packet.to;
        reply.to = this.packet.from;
        reply.payloadVariant.case = "decoded";
        reply.payloadVariant.value = data;

        const toRadio = new ToRadio();
        toRadio.payloadVariant.case = "packet";
        toRadio.payloadVariant.value = reply;
        
        await this.stream.sendToRadio(toRadio);

        console.debug(
            `[${new Date().toISOString()}]`,
            "CHATBOT Answer",
            text,
            `("${reply.from}" >=> "${reply.to}")`
        );
    }
}

export class SessionManager {
    sessions;

    constructor() {
        this.sessions = {};
    }

    get(addr) {
        if (typeof this.sessions[`${addr}`] === 'undefined') {
            this.sessions[`${addr}`] = new Session();
        }

        return this.sessions[`${addr}`];
    }
}

export class MeshtasticChatbot {
    me;
    stream;
    handler;
    sessionManager;
    agent;

    constructor(stream, agent, me) {
        this.stream = stream;
        this.agent = agent;
        this.me = me;
        this.handler = new MeshtasticPacketHandler(this.stream);
        this.sessionManager = new SessionManager();

        this.handler.on('textMessage', async (message,  _, packet,) => { await this.handleMessage(packet, message); });
    }
    
    async handleMessage(packet, message) {
        const from = packet.from;
        const to = packet.to;

        console.debug(
            `[${new Date().toISOString()}]`,
            "CHATBOT",
            message,
            `("${from}" >=> "${to}")`
        );

        if (to === this.me) {
            const session = this.sessionManager.get(from);
            const context = new Context(this.me, this.stream, packet, message, session);
            try {
                await this.agent.handleMessage(context);
            } catch(err) {
                context.reply('Beep, boop, chatbot failed 😞');
                console.log(err);
            }
        }
    }    
}
