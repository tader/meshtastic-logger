import { SerialPort } from 'serialport'
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import PcapWriter from 'node-pcap-writer';

import { MeshtasticSerial } from './meshtastic_serial.js';
import { MeshtasticLogger } from './meshtastic_logger.js';


const argv = yargs(hideBin(process.argv)).argv;
if (typeof(argv['port']) === 'undefined') {
    console.error("Please pass the serial port with the Meshtatstic device, eg, `npm start -- --port /dev/cu.usbserial-0001`")
    process.exit(1);
}


(async () => {
    const pcap = new PcapWriter(`log/meshtastic-log-${new Date().toISOString()}.pcap`, 512, 162);

    const port = new SerialPort({
        path: argv.port,
        baudRate: 115200,
    });

    const meshtasticSerial = new MeshtasticSerial(port);
    const meshtasticLogger = new MeshtasticLogger(meshtasticSerial);

    meshtasticSerial.on('fromRadio', (_, bytes) => { pcap.writePacket(bytes) });
})()
    .then((x) => {})
    .catch((x) => console.error(x))
    ;
