import { SerialPort } from 'serialport'
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import PcapWriter from 'node-pcap-writer';

import {default as config} from "./config.json" assert { type: "json" };

import { MeshtasticSerial } from './meshtastic_serial.js';
import { MeshtasticLogger } from './meshtastic_logger.js';
import { MeshtasticChatbot } from './meshtastic_chatbot.js';
import { OpenAIAgent } from './agents/openai.js';

const argv = yargs(hideBin(process.argv)).argv;
if (typeof(argv['port']) === 'undefined') {
    console.error("Please pass the serial port with the Meshtatstic device, eg, `npm start -- --port /dev/cu.usbserial-0001`")
    process.exit(1);
}


(async () => {
    const port = new SerialPort({
        path: argv.port,
        baudRate: 115200,
    });

    const meshtasticSerial = new MeshtasticSerial(port);
    
    // Log network traffic to stdout
    const meshtasticLogger = new MeshtasticLogger(meshtasticSerial);

    // Log network traffic to log/meshtastic-log-${timestamp}.pcap
    const pcap = new PcapWriter(`log/meshtastic-log-${new Date().toISOString()}.pcap`, 512, 162);
    meshtasticSerial.on('fromRadio', (_, bytes) => { pcap.writePacket(bytes) });

    // Start a chatbot
    const openAIAgent = new OpenAIAgent(config.OpenAIKey, config.OpenAIAssistantId, config.TavilyKey);
    const meshtasticChatbot = new MeshtasticChatbot(meshtasticSerial, openAIAgent, config.me);
})()
    .then((x) => {})
    .catch((x) => console.error(x))
    ;
