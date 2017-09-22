window.AudioContext = window.AudioContext || window.webkitAudioContext;
navigator.getUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
window.URL = window.URL || window.webkitURL;

var audioContext = new AudioContext();

// audio stream information
var mediaStreamSource;
var mediaStreamContext;

// AudioNode that we give a callback to to receive audio bytes
var audioNode;

// resampler object that resamples audio from 1 sampling rate to another
var resampler;

// the buffers that the audio we've recorded gets stored in until we send it to the server
var recordingBuffers = [];
var recordingLength = 0;

// server connection information
// edit HOST to point to the machine running the server
var HOST = "kaldi-dev:8888";
var CONTENT_TYPE = "content-type=audio/x-raw,+layout=(string)interleaved,+rate=(int)16000,+format=(string)S16LE,+channels=(int)1";
var SERVER_URL = "ws://" + HOST + "/client/ws/speech";
var webSocket;
var connected = false;

// key to setInterval() that sends audio
var sendAudioIntervalKey;
var recording = false;

// a div element that we will put the current sentence in
var currentSentence = document.getElementById('firstSentence');

window.onload = function() {
	console.log("Initializing...");
	requestAccessToAudio();
}

function requestAccessToAudio() {
	if (!navigator.getUserMedia) {
		console.log("No user media in this browser");
		return;
	}

	// when we receive permission, handleAudioAccessGranted will be called
	navigator.getUserMedia({audio: true}, handleAudioAccessGranted, function(e) {
		console.log("No live audio input in this browser: " + JSON.stringify(e));
	});
}

function handleAudioAccessGranted(stream) {
	mediaStreamSource = audioContext.createMediaStreamSource(stream);
	mediaStreamContext = mediaStreamSource.context;

	// make the analyser available in window context
	window.userSpeechAnalyser = audioContext.createAnalyser();
	mediaStreamSource.connect(window.userSpeechAnalyser);

	//Firefox loses the audio mediaStreamSource stream every five seconds
	// To fix added the mediaStreamSource to window.source
	window.source = mediaStreamSource;

	console.log('Media stream created');

	// register our callback for receiving audio
	audioNode = mediaStreamContext.createScriptProcessor(4096, 1, 1);
	audioNode.onaudioprocess = function(e) {
		if (!recording) {
			return;
		}

		buffer = e.inputBuffer.getChannelData(0);
		recordingBuffers.push(buffer);
		recordingLength += buffer.length;
	};

	mediaStreamSource.connect(audioNode);
	audioNode.connect(mediaStreamContext.destination);

	// initialize our resampler to transform the sample rate to 16khz
	resampler = new Resampler(mediaStreamContext.sampleRate, 16000, 1, 50*1024);
}

// note: websocket gets closed if no audio comes through, so this
// will get called when recording starts
function connectToServer() {
	var url = SERVER_URL + '?' + CONTENT_TYPE;
	console.log('Connecting to ' + url);

	webSocket = new WebSocket(url);
	webSocket.onopen = function(e) {
		console.log("WebSocket opened.");
		connected = true;
	}

	webSocket.onclose = function(e) {
		console.log("WebSocket closed.");
		connected = false;
	}

	webSocket.onerror = function(e) {
		console.log("WebSocket error: " + JSON.stringify(e));
	}

	webSocket.onmessage = function(e) {
		console.log(JSON.stringify(e));
		var res = JSON.parse(e.data);
		if (res.status == 0) {
			if (res.result) {
				console.log(JSON.stringify(res));
				currentSentence.innerHTML = res.result.hypotheses[0].transcript;

				// if the sentence is fully translated, create a new div
				// to put the next sentence in
				if (res.result.final) {
					currentSentence = document.createElement('div');
					document.getElementById('transcript').appendChild(currentSentence);
				}
			}
		} else {
			console.log("Server error: " + res.status + ": " + getDescription(res.status));
		}
	}
}

function getDescription(code) {
	// Server status codes
	// from https://github.com/alumae/kaldi-gstreamer-server
	var SERVER_STATUS_CODE = {
		0: 'Success', // Usually used when recognition results are sent
		1: 'No speech', // Incoming audio contained a large portion of silence or non-speech
		2: 'Aborted', // Recognition was aborted for some reason
		9: 'No available', // Recognizer processes are currently in use and recognition cannot be performed
	};
	if (code in SERVER_STATUS_CODE) {
		return SERVER_STATUS_CODE[code];
	}
	return "Unknown error";
}

// click handler for start/stop recording button
function onClick() {
	if (!recording) {
		startRecording();
	} else {
		stopRecording();
	}

	if (recording) {
		document.getElementById('btn').innerHTML = 'Stop Recording';
	} else {
		document.getElementById('btn').innerHTML = 'Start Recording';
	}
}

// connects to the websocket server and starts saving any audio we receive
// sends the recorded audio to the server every 250 ms
function startRecording() {
	if (recording) {
		console.log('Already recording.');
		return;
	}

	connectToServer();

	sendAudioIntervalKey = setInterval(function() {
		sendRecordedAudio();
		clearRecordedAudio();
	}, 250);
	recording = true;

	console.log("Started recording.");
}

// 1. flattens all the recorded audio we've received
// 2. resample it to 16 khz
// 3. encode it as 16 bit PCM audio
// 4. send over websocket
function sendRecordedAudio() {
	var buffer = flattenBuffers(recordingBuffers, recordingLength);
	var samples = resampler.resampler(buffer);
	var dataview = encodeRAW(samples);
	webSocket.send(new Blob([dataview], { type: 'audio/x-raw' }));
	console.log("Sent audio");
}

// flattens an array of arrays into 1 array
function flattenBuffers(buffers, totalLength) {
	var result = new Float32Array(totalLength);
	var offset = 0;
	for (var i = 0; i < buffers.length; i++){
		result.set(buffers[i], offset);
		offset += buffers[i].length;
	}
	return result;
}

// encode raw audio to 16 bit PCM
function encodeRAW(samples){
	var buffer = new ArrayBuffer(samples.length * 2);
	var view = new DataView(buffer);
	floatTo16BitPCM(view, 0, samples);
	return view;
}

function floatTo16BitPCM(output, offset, input){
	for (var i = 0; i < input.length; i++, offset+=2){
		var s = Math.max(-1, Math.min(1, input[i]));
		output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
	}
}

function clearRecordedAudio() {
	recordingLength = 0;
	recordingBuffers = [];
}

function stopRecording() {
	webSocket.send('EOS');
	webSocket = null;

	clearRecordedAudio();
	clearInterval(sendAudioIntervalKey);
	recording = false;
	console.log('Stopped recording');
}
