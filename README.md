# Meshtastic Logger

Captures Meshtastic traffic from the serial (USB) port of a Meshtastic node. Useful for learning how Meshtastic works and what is happening on the network.

The stock Meshtastic firmware ignores some packets:

  - packets that are not broadcasted and not addressed to your node
  - retransmissions of already seen packets
  - ?

It would be possible to compile a custom firmware with some tweaks to be able to capture these packets as well. (See below.)

Also, the logged packets may be altered by the firmware:

  - the firmware decrypts the packets it can decrypt
  - compressed text messages will be decompressed
  - the node's id is added to traceroute packets
  - ?


# Getting Started

- Clone this project
- Run `git submodule update --init --recursive` to obtain the protobufs
- Run `npm install`
- Run `npm start -- --port /dev/cu.usbmodem-0001` (update the port for your device)


# Wireshark

## Configure
- Copy `wireshark/plugins/meshtastic.lua` to `~/.local/lib/wireshark/plugins/meshtastic.lua` (I have created a symbolic link instead)
- Wireshark > Preferences > Protocols > ProtoBuf:
    - `[ Edit... ]` Protobuf search paths
        - Add `[ + ]` the protobufs directory in this project
        - tick "Load all files"
    - tick "Dissect Protobuf fields as Wireshark fields"
- Wireshark > Preferences > Protocols > DLT_USER:
    - `[ Edit... ]` Encapsulations Table
        - Add `[ + ]` DLT `User 15 (DLT=162)` with Payload dissector `meshtastic` (textfield with autocomplete)

## Open

Just use File > Open to open one of the generated pcap files.

## Stream

Run Wireshark as follows to see packages appear as they are received:

```
/Applications/Wireshark.app/Contents/MacOS/Wireshark -k -i <(tail -f -c +0 meshtastic-log-2024-03-21T00:00:00.000Z.pcap)
```


# Patching the Meshtastic firmware

To see more packets, the Meshtastic firmware can be patched, however:

  - I will not support this
  - Disable TX (Lora settings) on your node, just to be sure
  - See: https://meshtastic.org/docs/development/firmware/build/

###### `src/mesh/FloodingRouter.cpp`
```diff
             // cancel rebroadcast of this message *if* there was already one, unless we're a router/repeater!
             Router::cancelSending(p->from, p->id);
         }
-        return true;
+        return false;
     }

     return Router::shouldFilterReceived(p);
```

###### `src/modules/RoutingModule.cpp`
```diff
     // FIXME - move this to a non promsicious PhoneAPI module?
     // Note: we are careful not to send back packets that started with the phone back to the phone
-    if ((mp.to == NODENUM_BROADCAST || mp.to == nodeDB->getNodeNum()) && (mp.from != 0)) {
+    if (mp.from != 0) {

     return false; // Let others look at this message also if they want
 }
```


## OpenAI Chat Agent


Create an OpenAI Assistant: https://platform.openai.com/assistants

Suggestions:

- Name: Meshtastic Station Operator
- Instructions:
      You acting as an unlicensed HAM amateur on the LoRa based Meshtastic network.
      You are responding to received messages.
      In your first response, mention you are a large language model, not a human.
      Respond friendly.
      Your answer can take at most 228 bytes when UTF-8 encoded, keep it short!
      Don't ask follow-up questions, unless needed for answering a question from the user.
      Understand that network is lossy, messages may not have been received by you or the user.

      If a message reads "ping", "hey", or similar, please respond with a pong response including signal quality information.

      You are not allowed to make up things, like for example weather conditions.
      To lookup facts, you could try a web search using the "tavily_search" function.

For web search I added the tavily_search function (don't add this if you don't want to allow the assistant to search the web):

```json
{
  "name": "tavily_search",
  "description": "Get information on recent events from the web.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "The search query to use. For example: 'Latest news on Nvidia stock performance'"
      }
    },
    "required": [
      "query"
    ]
  }
}
```

Copy `config.json.example` as `config.json` and update the values:

  - set the decimal version of your node's address as `me`
  - set an OpenAI Key, Assistant ID
  - set and Tavily Token (if applicable)
