/*
    2013, @muazkh - github.com/muaz-khan
    MIT License - https://webrtc-experiment.appspot.com/licence/
    Documentation - https://github.com/muaz-khan/WebRTC-Experiment/tree/master/file-hangout
*/

(function() {

    // a middle-agent between public API and the Signaler object
    window.DataConnection = function(channel) {
        var signaler, self = this;
        this.channel = channel;

        // get alerted for each new meeting
        this.onconnection = function(room) {
            if (self.detectedRoom) return;
            self.detectedRoom = true;

            self.join(room);
        };

        function initSignaler() {
            signaler = new Signaler(self);
        }

        // setup new meeting room
        this.setup = function(roomid) {
            !signaler && initSignaler();
            signaler.broadcast({
                roomid: roomid || self.channel
            });
        };

        // join pre-created data connection
        this.join = function(room) {
            !signaler && initSignaler();
            signaler.join({
                to: room.userid,
                roomid: room.roomid
            });
        };

        this.send = function(data, _channel) {
            if (!data) throw 'No file, data or text message to share.';
            if (data.size)
                FileSender.send({
                    file: data,
                    root: self,
                    channel: _channel
                });
            else
                TextSender.send({
                    text: data,
                    root: self,
                    channel: _channel
                });
        };

        // check pre-created meeting rooms
        this.check = initSignaler;
    };

    // it is a backbone object

    function Signaler(root) {
        // unique session-id
        var channel = root.channel;

        // signaling implementation
        // if no custom signaling channel is provided; use Firebase
        if (!root.openSignalingChannel) {
            if (!window.Firebase) throw 'You must link <https://cdn.firebase.com/v0/firebase.js> file.';

            // Firebase is capable to store data in JSON format
            root.transmitOnce = true;
            var socket = new Firebase('https://' + (root.firebase || 'chat') + '.firebaseIO.com/' + channel);
            socket.on('child_added', function(data) {
                data = data.val();
                if (data.userid != userid) {
                    if (data.leaving && root.onuserleft) root.onuserleft(data.userid);
                    else signaler.onmessage(data);
                }
            });

            // method to signal the data
            this.signal = function(data) {
                data.userid = userid;
                socket.push(data);
            };
        } else {
            // custom signaling implementations
            // e.g. WebSocket, Socket.io, SignalR, WebSycn, XMLHttpRequest, Long-Polling etc.
            var socket = root.openSignalingChannel(function(message) {
                message = JSON.parse(message);
                if (message.userid != userid) {
                    if (message.leaving && root.onuserleft) root.onuserleft(message.userid);
                    else signaler.onmessage(message);
                }
            });

            // method to signal the data
            this.signal = function(data) {
                data.userid = userid;
                socket.send(JSON.stringify(data));
            };
        }

        // unique identifier for the current user
        var userid = root.userid || getToken();

        // self instance
        var signaler = this;

        // object to store all connected peers
        var peers = { };

        // object to store ICE candidates for answerer
        var candidates = { };

        // object to store all connected participants's ids
        var participants = { };

        // it is called when your signaling implementation fires "onmessage"
        this.onmessage = function(message) {
            // if new room detected
            if (message.roomid && message.broadcasting && !signaler.sentParticipationRequest)
                root.onconnection(message);

            else
                // for pretty logging
                console.debug(JSON.stringify(message, function(key, value) {
                    if (value.sdp) {
                        console.log(value.sdp.type, '————', value.sdp.sdp);
                        return '';
                    } else return value;
                }, '————'));

            // if someone shared SDP
            if (message.sdp && message.to == userid)
                this.onsdp(message);

            // if someone shared ICE
            if (message.candidate && message.to == userid)
                this.onice(message);

            // if someone sent participation request
            if (message.participationRequest && message.to == userid) {
                participationRequest(message.userid);
            }

            // session initiator transmitted new participant's details
            // it is useful for multi-user connectivity
            if (message.conferencing && message.newcomer != userid && !!participants[message.newcomer] == false) {
                participants[message.newcomer] = message.newcomer;
                root.stream && signaler.signal({
                    participationRequest: true,
                    to: message.newcomer
                });
            }
        };

        function participationRequest(_userid) {
            // it is appeared that 10 or more users can send 
            // participation requests concurrently
            // onicecandidate fails in such case
            if (!signaler.creatingOffer) {
                signaler.creatingOffer = true;
                createOffer(_userid);
                setTimeout(function() {
                    signaler.creatingOffer = false;
                    if (signaler.participants &&
                        signaler.participants.length) repeatedlyCreateOffer();
                }, 30000);
            } else {
                if (!signaler.participants) signaler.participants = [];
                signaler.participants[signaler.participants.length] = _userid;
            }
        }

        // reusable function to create new offer

        function createOffer(to) {
            var _options = options;
            _options.to = to;
            _options.stream = root.stream;
            peers[to] = Offer.createOffer(_options);
        }

        // reusable function to create new offer repeatedly

        function repeatedlyCreateOffer() {
            console.log('signaler.participants', signaler.participants);
            var firstParticipant = signaler.participants[0];
            if (!firstParticipant) return;

            signaler.creatingOffer = true;
            createOffer(firstParticipant);

            // delete "firstParticipant" and swap array
            delete signaler.participants[0];
            signaler.participants = swap(signaler.participants);

            setTimeout(function() {
                signaler.creatingOffer = false;
                if (signaler.participants[0])
                    repeatedlyCreateOffer();
            }, 30000);
        }

        // if someone shared SDP
        this.onsdp = function(message) {
            var sdp = message.sdp;

            if (sdp.type == 'offer') {
                var _options = options;
                _options.stream = root.stream;
                _options.sdp = sdp;
                _options.to = message.userid;
                peers[message.userid] = Answer.createAnswer(_options);
            }

            if (sdp.type == 'answer') {
                peers[message.userid].setRemoteDescription(sdp);
            }
        };

        // if someone shared ICE
        this.onice = function(message) {
            var peer = peers[message.userid];
            if (!peer) {
                var candidate = candidates[message.userid];
                if (candidate) candidates[message.userid][candidate.length] = message.candidate;
                else candidates[message.userid] = [message.candidate];
            } else {
                peer.addIceCandidate(message.candidate);

                var _candidates = candidates[message.userid] || [];
                if (_candidates.length) {
                    for (var i = 0; i < _candidates.length; i++) {
                        peer.addIceCandidate(_candidates[i]);
                    }
                    candidates[message.userid] = [];
                }
            }
        };

        // it is passed over Offer/Answer objects for reusability
        var options = {
            onsdp: function(sdp, to) {
                signaler.signal({
                    sdp: sdp,
                    to: to
                });
            },
            onicecandidate: function(candidate, to) {
                signaler.signal({
                    candidate: candidate,
                    to: to
                });
            },
            onopen: function(channel, _userid) {
                if (!root.channels) root.channels = { };
                root.channels[_userid] = {
                    send: function(message) {
                        root.send(message, this.channel);
                    },
                    channel: channel
                };
                if (root.onopen) root.onopen(_userid);
                forwardParticipant(_userid);
            },
            onmessage: function(message, _userid) {
                if (!message.size)
                    message = JSON.parse(message);

                if (message.type === 'text')
                    textReceiver.receive({
                        data: message,
                        root: root,
                        userid: _userid
                    });

                else if (message.size || message.type === 'file')
                    fileReceiver.receive({
                        data: message,
                        root: root,
                        userid: _userid
                    });
                else if (root.onmessage)
                    root.onmessage(message, _userid);
            },
            onclose: function(e, _userid) {
                if (root.onclose) root.onclose(e, _userid);
            },
            onerror: function(e, _userid) {
                if (root.onerror) root.onerror(e, _userid);
            }
        };

        function forwardParticipant(_userid) {
            // for multi-users connectivity
            signaler.isbroadcaster &&
                signaler.signal({
                    conferencing: true,
                    newcomer: _userid
                });
        }

        var textReceiver = new TextReceiver();
        var fileReceiver = new FileReceiver();

        // call only for session initiator
        this.broadcast = function(_config) {
            signaler.roomid = _config.roomid || getToken();
            signaler.isbroadcaster = true;
            (function transmit() {
                signaler.signal({
                    roomid: signaler.roomid,
                    broadcasting: true
                });

                !root.transmitOnce && setTimeout(transmit, 30000);
            })();

            // if broadcaster leaves; clear all JSON files from Firebase servers
            if (socket.onDisconnect) socket.onDisconnect().remove();
        };

        // called for each new participant
        this.join = function(_config) {
            signaler.roomid = _config.roomid;
            this.signal({
                participationRequest: true,
                to: _config.to
            });
            signaler.sentParticipationRequest = true;
        };

        unloadHandler(userid, signaler);
    }

    // reusable stuff
    var RTCPeerConnection = window.mozRTCPeerConnection || window.webkitRTCPeerConnection;
    var RTCSessionDescription = window.mozRTCSessionDescription || window.RTCSessionDescription;
    var RTCIceCandidate = window.mozRTCIceCandidate || window.RTCIceCandidate;

    navigator.getUserMedia = navigator.mozGetUserMedia || navigator.webkitGetUserMedia;
    window.URL = window.webkitURL || window.URL;

    var isFirefox = !!navigator.mozGetUserMedia;
    var isChrome = !!navigator.webkitGetUserMedia;

    var STUN = {
        url: isChrome ? 'stun:stun.l.google.com:19302' : 'stun:23.21.150.121'
    };

    var TURN = {
        url: 'turn:webrtc%40live.com@numb.viagenie.ca',
        credential: 'muazkh'
    };

    var iceServers = {
        iceServers: [STUN]
    };

    if (isChrome) {
        if (parseInt(navigator.userAgent.match( /Chrom(e|ium)\/([0-9]+)\./ )[2]) >= 28)
            TURN = {
                url: 'turn:numb.viagenie.ca',
                credential: 'muazkh',
                username: 'webrtc@live.com'
            };

        // No STUN to make sure it works all the time!
        iceServers.iceServers = [TURN];
    }

    var optionalArgument = {
        optional: [{
            RtpDataChannels: isChrome
        }]
    };

    var offerAnswerConstraints = {
        optional: [],
        mandatory: {
            OfferToReceiveAudio: isFirefox,
            OfferToReceiveVideo: isFirefox
        }
    };

    function getToken() {
        return Math.round(Math.random() * 60535) + 5000;
    }
	
    function setBandwidth(sdp) {
        // Firefox has no support of "b=AS"
        if (isFirefox) return sdp;

        // remove existing bandwidth lines
        sdp = sdp.replace(/b=AS([^\r\n]+\r\n)/g, '');
        sdp = sdp.replace(/a=mid:data\r\n/g, 'a=mid:data\r\nb=AS:1638400\r\n');

        return sdp;
    }

    /*
    var offer = Offer.createOffer(config);
    offer.setRemoteDescription(sdp);
    offer.addIceCandidate(candidate);
    */
    var Offer = {
        createOffer: function(config) {
            var peer = new RTCPeerConnection(iceServers, optionalArgument);
            DataChannel.createDataChannel(peer, config);
            if (config.onicecandidate)
                peer.onicecandidate = function(event) {
                    if (event.candidate) config.onicecandidate(event.candidate, config.to);
                };

            if (isChrome) {
                peer.createOffer(function(sdp) {
                    sdp.sdp = setBandwidth(sdp.sdp);
                    peer.setLocalDescription(sdp);
                    if (config.onsdp) config.onsdp(sdp, config.to);
                }, null, offerAnswerConstraints);
            } else if (isFirefox) {
                navigator.mozGetUserMedia({
                        audio: true,
                        fake: true
                    }, function(stream) {
                        peer.addStream(stream);
                        peer.createOffer(function(sdp) {
                            sdp.sdp = setBandwidth(sdp.sdp);
                            peer.setLocalDescription(sdp);
                            if (config.onsdp) config.onsdp(sdp, config.to);
                        }, null, offerAnswerConstraints);
                    }, function() {});
            }

            this.peer = peer;

            return this;
        },
        setRemoteDescription: function(sdp) {
            this.peer.setRemoteDescription(new RTCSessionDescription(sdp));
        },
        addIceCandidate: function(candidate) {
            this.peer.addIceCandidate(new RTCIceCandidate({
                sdpMLineIndex: candidate.sdpMLineIndex,
                candidate: candidate.candidate
            }));
        }
    };

    /*
    var answer = Answer.createAnswer(config);
    answer.setRemoteDescription(sdp);
    answer.addIceCandidate(candidate);
    */
    var Answer = {
        createAnswer: function(config) {
            var peer = new RTCPeerConnection(iceServers, optionalArgument), channel;
            if (isChrome)
                DataChannel.createDataChannel(peer, config);
            else if (isFirefox) {
                peer.ondatachannel = function(event) {
                    channel = event.channel;
                    channel.binaryType = 'blob';
                    DataChannel.setChannelEvents(channel, config);
                };

                navigator.mozGetUserMedia({
                        audio: true,
                        fake: true
                    }, function(stream) {
                        peer.addStream(stream);
                        peer.setRemoteDescription(new RTCSessionDescription(config.sdp));
                        peer.createAnswer(function(sdp) {
                            sdp.sdp = setBandwidth(sdp.sdp);
                            peer.setLocalDescription(sdp);
                            if (config.onsdp) config.onsdp(sdp, config.to);
                        }, null, offerAnswerConstraints);
                    }, function() {});
            }
            if (config.onicecandidate)
                peer.onicecandidate = function(event) {
                    if (event.candidate) config.onicecandidate(event.candidate, config.to);
                };

            if (isChrome) {
                peer.setRemoteDescription(new RTCSessionDescription(config.sdp));
                peer.createAnswer(function(sdp) {
                    sdp.sdp = setBandwidth(sdp.sdp);
                    peer.setLocalDescription(sdp);
                    if (config.onsdp) config.onsdp(sdp, config.to);
                }, null, offerAnswerConstraints);
            }

            this.peer = peer;

            return this;
        },
        addIceCandidate: function(candidate) {
            this.peer.addIceCandidate(new RTCIceCandidate({
                sdpMLineIndex: candidate.sdpMLineIndex,
                candidate: candidate.candidate
            }));
        }
    };

    var DataChannel = {
        createDataChannel: function(peer, config) {
            var channel = peer.createDataChannel('channel', { reliable: false });
            this.setChannelEvents(channel, config);
        },
        setChannelEvents: function(channel, config) {
            channel.onopen = function() {
                config.onopen(channel, config.to);
            };

            channel.onmessage = function(e) {
                config.onmessage(e.data, config.to);
            };

            channel.onclose = function(e) {
                config.onclose(e, config.to);
            };

            channel.onerror = function(e) {
                config.onerror(e, config.to);
            };
        }
    };

    var FileSaver = {
        SaveToDisk: function(e) {
            var save = document.createElement('a');
            save.href = e.fileURL;
            save.target = '_blank';
            save.download = e.fileName || e.fileURL;

            var evt = document.createEvent('MouseEvents');
            evt.initMouseEvent('click', true, true, window, 1, 0, 0, 0, 0, false, false, false, false, 0, null);

            save.dispatchEvent(evt);
            (window.URL || window.webkitURL).revokeObjectURL(save.href);
        }
    };

    var FileSender = {
        send: function(config) {
            var root = config.root;
            var file = config.file;

            function send(message) {
                if (!isFirefox) message = JSON.stringify(message);

                // share data between two unique users i.e. direct messages
                if (config.channel) return config.channel.send(message);

                // share data with all connected users
                var channels = root.channels || { };
                for (channel in channels) channels[channel].send(message);
            }

            if (isFirefox) {
                send(JSON.stringify({
                    fileName: file.name,
                    type: 'file'
                }));
                send(file);
                if (root.onFileSent) root.onFileSent(file);
            }

            if (!isFirefox) {
                var reader = new window.FileReader();
                reader.readAsDataURL(file);
                reader.onload = onReadAsDataURL;
            }

            var packetSize = 1000,
                textToTransfer = '',
                numberOfPackets = 0,
                packets = 0;

            function onReadAsDataURL(event, text) {
                var data = {
                    type: 'file'
                };

                if (event) {
                    text = event.target.result;
                    numberOfPackets = packets = data.packets = parseInt(text.length / packetSize);
                }

                root.onFileProgress({
                    remaining: packets--,
                    length: numberOfPackets,
                    sent: numberOfPackets - packets
                });

                if (text.length > packetSize)
                    data.message = text.slice(0, packetSize);
                else {
                    data.message = text;
                    data.last = true;
                    data.name = file.name;

                    if (root.onFileSent) root.onFileSent(file);
                }

                send(data);

                textToTransfer = text.slice(data.message.length);

                if (textToTransfer.length)
                    setTimeout(function() {
                        onReadAsDataURL(null, textToTransfer);
                    }, 500);
            }
        }
    };

    function FileReceiver() {
        var content = [],
            fileName = '',
            packets = 0,
            numberOfPackets = 0;

        this.receive = function(config) {
            var root = config.root;
            var data = config.data;

            if (isFirefox) {
                if (data.fileName)
                    fileName = data.fileName;

                if (data.size) {
                    var reader = new window.FileReader();
                    reader.readAsDataURL(data);
                    reader.onload = function(event) {
                        FileSaver.SaveToDisk({
                            fileURL: event.target.result,
                            fileName: fileName
                        });

                        if (root.onFileReceived) root.onFileReceived(fileName, config.userid);
                    };
                }
            }

            if (!isFirefox) {
                if (data.packets)
                    numberOfPackets = packets = parseInt(data.packets);

                if (root.onFileProgress)
                    root.onFileProgress({
                        remaining: packets--,
                        length: numberOfPackets,
                        received: numberOfPackets - packets,
                        userid: config.userid
                    });

                content.push(data.message);

                if (data.last) {
                    FileSaver.SaveToDisk({
                        fileURL: content.join(''),
                        fileName: data.name
                    });

                    if (root.onFileReceived) root.onFileReceived(data.name, config.userid);
                    content = [];
                }
            }
        };
    }

    var TextSender = {
        send: function(config) {
            var root = config.root;

            function send(message) {
                message = JSON.stringify(message);

                // share data between two unique users i.e. direct messages
                if (config.channel) return config.channel.send(message);

                // share data with all connected users
                var channels = root.channels || { };
                for (channel in channels) channels[channel].send(message);
            }


            var initialText = config.text,
                packetSize = 1000,
                textToTransfer = '';

            if (isFirefox || initialText.length <= packetSize)
                send(initialText);
            else
                sendText(initialText);

            function sendText(textMessage, text) {
                var data = {
                    type: 'text'
                };

                if (textMessage) {
                    text = textMessage;
                    data.packets = parseInt(text.length / packetSize);
                }

                if (text.length > packetSize)
                    data.message = text.slice(0, packetSize);
                else {
                    data.message = text;
                    data.last = true;
                }

                send(data);

                textToTransfer = text.slice(data.message.length);

                if (textToTransfer.length)
                    setTimeout(function() {
                        sendText(null, textToTransfer);
                    }, 500);
            }
        }
    };

    function TextReceiver() {
        var content = [];

        function receive(config) {
            var root = config.root;
            var data = config.data;

            content.push(data.message);
            if (data.last) {
                if (root.onmessage) root.onmessage(content.join(''), config.userid);
                content = [];
            }
        }

        return {
            receive: receive
        };
    }

    // swap arrays

    function swap(arr) {
        var swapped = [],
            length = arr.length;
        for (var i = 0; i < length; i++)
            if (arr[i] && arr[i] !== true)
                swapped[swapped.length] = arr[i];
        return swapped;
    }

    function unloadHandler(userid, signaler) {
        window.onbeforeunload = function() {
            leaveRoom();
            // return 'You\'re leaving the session.';
        };

        window.onkeyup = function(e) {
            if (e.keyCode == 116)
                leaveRoom();
        };

        var anchors = document.querySelectorAll('a'),
            length = anchors.length;
        for (var i = 0; i < length; i++) {
            var a = anchors[i];
            if (a.href.indexOf('#') !== 0 && a.getAttribute('target') != '_blank')
                a.onclick = function() {
                    leaveRoom();
                };
        }

        function leaveRoom() {
            signaler.signal({
                leaving: true
            });
        }
    }
})();
