const fs = require('fs'),
loki = require('lokijs'),
request = require('request'),
express = require('express'),
path = require('path'),
urlPattern = require('url-pattern');

var db = new loki('loki.json'),
nodes = db.addCollection('nodes', {indices: [ 'id' ]}),
lines = db.addCollection('lines', {indices: [ 'id' ]}),
gridElements = db.addCollection('gridElements', {indices: [ 'id' ]}),
nodeToDevice = db.addCollection('nodeToDevice', {indices: [ 'nodeId' ]}),
app = express();

var content, sequenceHwm = 0, nodeHwm = 0, lineHwm = 0, origFeatures;

function initialise() {
  console.log("Initialising...");
  fs.readFile('./data/adms_network_data_with_meters.geo.json', function read(err, data) {
      if (err) {
          throw err;
      }
      content = JSON.parse(data);

      origFeatures = JSON.parse(JSON.stringify(content));

      processFile();
  });
}

function reload() {
  // Clear out the loki database first.
  nodes.clear();
  lines.clear();
  gridElements.clear()
  nodeToDevice.clear();
  // Copy the file into place.
  fs.copyFile('./data/adms_data_with_meters.geojson', './data/adms_network_data_with_meters.geo.json', (err) => {
    if (err) throw err;
    console.log('adms_data_with_meters.geojson was copied to adms_network_data_with_meters.geo.json');
    // Now initialise again.
    initialise();
  });
}

function loadData(content) {
  var features = content.features;

  var classification = {
    classes: {}
  };

  features.forEach(function(aFeature) {
    var aClass = aFeature.properties.data.Class;
    var category = aFeature.properties.data.Category;

    aFeature.id = aFeature.properties.data.Id;

    if (aFeature.properties.data.Sequence > sequenceHwm)
      sequenceHwm = aFeature.properties.data.Sequence;

    switch(aClass) {
      case 'Node':
        var existing = nodes.find({id: aFeature.id});
        if (existing.length < 1) {
          nodes.insert(aFeature);
          var nodeId = Number(aFeature.properties.data.Id);
          if (nodeId > nodeHwm)
            nodeHwm = nodeId;
        }
        break;
      case 'Line':
        var existing = lines.find({id: aFeature.id});
        if (existing.length < 1) {
          lines.insert(aFeature);
          var lineId = Number(aFeature.properties.data.Id);
          if (lineId > lineHwm)
            lineHwm = lineId;
        }
        break;
      case 'Source':
        var existing = gridElements.find({id: aFeature.id});
        if (existing.length < 1) {
          gridElements.insert(aFeature);
        }
        break;
      case 'SmartInverter':
        gridElements.insert(aFeature);
        break;
      case 'Device':
        gridElements.insert(aFeature);

        // Create a lookup entry from Nodes to Devices. That is, if you know a Node's id, you can quickly retrieve associated Device ids using this
        // table.
        if (aFeature.properties.data.hasOwnProperty('ConnectedNodes')) {
          // Load type Devices have a property called ConnectedNodes that defines the relationship.
          var connectedNodes = aFeature.properties.data.ConnectedNodes;
          connectedNodes.forEach(function(aNodeId) {
            nodeToDevice.insert({
              nodeId: aNodeId,
              deviceId: aFeature.id
            });
          });
        }
        if (aFeature.properties.data.hasOwnProperty('Node')) {
          // Switch type Devices have a property called Node that defines the relationship.
          nodeToDevice.insert({
            nodeId: aFeature.properties.data.Node,
            deviceId: aFeature.id
          });
        }
        break;
      default:
        console.log("Do not recognise class " + aClass);
        break;
    }
  });
}

function doTrace(aGridElement) {
  var connectedNodes = aGridElement.properties.data.ConnectedNodes;

  connectedNodes.forEach(function(aNodeId) {
    var relatedNodes = nodes.find({id: aNodeId});
  })
}

function processFile() {
    loadData(content);

    var results = gridElements.find({id: 'J433'});

    results.forEach(function(aFeature) {
      console.log(aFeature.id + ": " + aFeature.properties.data.Class + ': ' + aFeature.properties.data.Category);
    });
};

app.get('/nodes', function (req, res) {
  console.log("Got nodes request...");
  res.send(JSON.stringify({
    type: 'FeatureCollection',
    features: nodes.find()
  }));
});

app.get('/lines', function (req, res) {
  console.log("Got lines request...");
  res.send(JSON.stringify({
    type: 'FeatureCollection',
    features: lines.find()
  }));
});

app.get('/reload', function(req, res) {
  console.log("Got a reload request...");
  reload();
  res.send("ok");
});

function traverseNodeTreeDownstream(aNodeId, processedElements, processedNodes, processedLines, processedDevices, stopNodes) {
    // aNodeId is the id of the node we're currently processing.
    // The argument processedElements is the parent to which children may be added in this function.
    //
    // aNodeId is the id of a node related to the device that we are tracing from. We will use it to find other Devices connectedDeviceIds
    // at the same Node as well as Lines.

    var currentNodeId = aNodeId;
    var results = nodes.find({id: aNodeId});

    // Find all the Devices connected to this Node and add them to the list.
    var connectedDeviceIds = nodeToDevice.find({nodeId: aNodeId});

    connectedDeviceIds.forEach(function(nodeLookup) {
      var deviceId = nodeLookup.deviceId;

      // Attached all Devices that we haven't already processed to the tree.
      if (!processedDevices.includes(deviceId)) {
        var result = gridElements.find({id: deviceId});

        result.forEach(function(aDevice) {
          var anElement = {
            root: aDevice,
            children: []
          };

          processedElements.children.push(anElement);
          processedDevices.push(deviceId);

          if (aDevice.properties.data.Category == "Switch" && aDevice.properties.data.Status == "Open") {
            // Found an open Switch attached to this Line, push the Switch's node onto the stop node list.
            stopNodes.push(aDevice.properties.data.Node);
            // Remember that we have processed this Node and its Devices by pushing its Id onto processedNodes.
            if (!processedNodes.includes(aDevice.properties.data.Node))
              processedNodes.push(aDevice.properties.data.Node);
          }
        })
      };
    });

    // Find all the Lines connected to this Node. Ones that are downstream of this Node will
    // be added to the list. Also the other Node attached to the end of the Line will be used
    // to continue traversing downstream.
    results.forEach(function(aNode) {
      // Find the Lines that are connected to this Node.
      var connectedLineIds = aNode.properties.data.ConnectedLines;

      connectedLineIds.forEach(function(aLineId) {
          var results = lines.find({id: aLineId});
          results.forEach(function(aLine) {
            if (aNode.properties.data.Sequence < aLine.properties.data.Sequence) {
              // We assume that if the sequence number of the node is less than the line, then the node is upstream of the line, so add it to the results.
              processedLines.push(aLineId);

              if (!stopNodes.includes(currentNodeId)) {
                var currentElement = {
                  root: aLine,
                  children: []
                };
                processedElements.children.push(currentElement);

                // A line may or may not have connected devices. However it will always have two connected nodes.
                var connectedNodeIds = aLine.properties.data.ConnectedNodes;

                connectedNodeIds.forEach(function(anotherNodeId) {
                  if (anotherNodeId != currentNodeId && !processedNodes.includes(anotherNodeId) && !stopNodes.includes(anotherNodeId)) {
                    // If the next node is not the same as the one we're processing here, carry on down the tree.
                    currentElement = traverseNodeTreeDownstream(anotherNodeId, currentElement, processedNodes, processedLines, processedDevices, stopNodes);
                  };
                });
              };
            };
        });

        processedNodes.push(currentNodeId);
      });
    });

  return processedElements;
}

function traceDownStream(deviceId) {
  elems = gridElements.find({id: deviceId});

  var topologyTree = [];

  // This is the tree of Devices and Lines that will be eventually returned back to the requesting client.
  var processedElements;

  // These arrays are used to "remember" which elements we have already visited as we traverse the connectivity.
  // 'stopNodes' is a collections of nodes associated with open Switches. If we encounter a stop node while
  // traversing, we stop traversing.
  var processedNodes = [], processedLines = [], processedDevices = [], stopNodes = [];

  // If there is more than one element for the supplied deviceId, use only the first one. This would be the case
  // if you supplied the id 'J433', which refers to both a Source - Substation and a Source - Feeder.
  var anElement = elems[0];

  // Add this starting device at the top of the tree.
  processedElements = {
    root: anElement,
    children: []
  };
  processedDevices.push(deviceId);

  // Retrieve this element's node id(s). Depending on what Category of thing it is, this could be using the
  // property ConnectedNodes or Node.

  if (anElement.properties.data.hasOwnProperty('ConnectedNodes')) {
    // Element uses ConnectedNodes e.g. a feeder source.
    var nodeIds = anElement.properties.data.ConnectedNodes;

    nodeIds.forEach(function(aNodeId) {
      // Recursively traverse downstream.
      processedElements = traverseNodeTreeDownstream(aNodeId, processedElements, processedNodes, processedLines, processedDevices, stopNodes);
    });
  }
  else {
    // This element only has a single Node (e.g. is a Fuse).
    var nodeId = anElement.properties.data.Node;
    // Recursively traverse downstream.
    processedElements = traverseNodeTreeDownstream(nodeId, processedElements, processedNodes, processedLines, processedDevices, stopNodes);
  }

  topologyTree.push(processedElements);

  return topologyTree;
}

app.get('/tracedownstream', function(req, res) {
  console.log("Got tracedownstream request...");

  const pattern = new urlPattern(
		  /^\/tracedownstream\?id=(.*)$/,
		  ['id']
		);

	const results = pattern.match(req.url);

  var processedElements = traceDownStream(results.id);

  res.send(JSON.stringify(processedElements));
})

function doAddMeter(results) {
  // Adds a new meter object to the JSON document. Takes care of the relationships that Meter
  // must have to loads, nodes and lines.

  var loadid = results.loadid;
  var lat = results.lat;
  var lon = results.lon;
  var load = gridElements.find({id: loadid})[0];
  var normalPhase = load.properties.data.Normal;
  var closedPhase = load.properties.data.Closed;
  var oldNode = nodes.find({id: load.properties.data.ConnectedNodes[0]})[0];
  var newLineId = (++lineHwm).toString();
  var newNodeId = (++nodeHwm).toString();
  var meterId = "ME" + (sequenceHwm++).toString();
  var dateNow = new Date().toString();

  // Create a new line to connect from the Load to the Meter.
  var newLine = {
      "geometry": {
          "type": "LineString",
          "coordinates": [
              [
                oldNode.geometry.coordinates[0],
                oldNode.geometry.coordinates[1]
              ],
              [
                Number(lon),
                Number(lat)
              ]
          ]
      },
      "type": "Feature",
      "properties": {
          "map": {
              "ID": newLineId
          },
          "data": {
              "Class": "Line",
              "Category": "Line",
              "Action": "Create",
              "Sequence": sequenceHwm++,
              "RecordedAt": dateNow,
              "Id": newLineId,
              "Name": "J433",
              "Normal": normalPhase,
              "Closed": closedPhase,
              "State": 1,
              "DistanceFromFeeder": 2,
              "ConnectedNodes": [
                  oldNode.properties.data.Id,
                  newNodeId
              ],
              "ConnectedDevices": [
                  meterId
              ],
              "RatedCurrent": 250.0,
              "Length": 22.78700065612793,
              "Resistance": 10.0,
              "Reactance": 10.0
          }
      }
  };

  // The new Line must be in the list of connected Lines for the existing Node.
  origFeatures.features.forEach(function(aFeature) {
    if (aFeature.properties.data.Id == oldNode.properties.data.Id)
      aFeature.properties.data.ConnectedLines.push(newLine.properties.data.Id);
  });

  // Create a new Node at the supplied location of the Meter.
  var newNode = {
    "geometry": {
        "type": "Point",
        "coordinates": [
            Number(lon),
            Number(lat)
        ]
    },
    "type": "Feature",
    "properties": {
        "map": {
            "ID": newNodeId
        },
        "data": {
            "Class": "Node",
            "Category": "Node",
            "Action": "Create",
            "Sequence": sequenceHwm++,
            "RecordedAt": dateNow,
            "Id": newNodeId,
            "Name": "Node" + sequenceHwm.toString(),
            "Normal": normalPhase,
            "Closed": closedPhase,
            "State": 1,
            "DistanceFromFeeder": 1,
            "CurrentFeeder": "J433",
            "ConnectedLines": [
                newLineId
            ]
        }
    }
  };

  // Create a Meter and relate it to the new Node created above.
  var newMeter = {
      "geometry": {
          "type": "Point",
          "coordinates": [
              Number(lon),
              Number(lat)
          ]
      },
      "type": "Feature",
      "properties": {
          "map": {
              "ID": meterId
          },
          "data": {
              "Class": "Device",
              "Category": "Meter",
              "Action": "Create",
              "Sequence": sequenceHwm,
              "RecordedAt": dateNow,
              "Id": meterId,
              "Name": meterId,
              "Normal": normalPhase,
              "Closed": closedPhase,
              "State": 1,
              "DistanceFromFeeder": 84,
              "ConnectedNodes": [
                  newNodeId
              ]
          }
      }
  };

  origFeatures.features.push(newLine);
  origFeatures.features.push(newNode);
  origFeatures.features.push(newMeter);
}

app.get('/addmeter', function(req, res) {
  console.log("Got addmeter request...");

  const pattern = new urlPattern(
		  /^\/addmeter\?loadid=(.*)\&lat=([-+]?[0-9]*\.?[0-9]+)\&lon=([-+]?[0-9]*\.?[0-9]+)$/,
		  ['loadid', 'lat', 'lon']
		);

	const results = pattern.match(req.url);

  console.log("Adding meter at Load " + results.loadid + " at position " + results.lat + ", " + results.lon);

  doAddMeter(results);

  fs.writeFile("./data/adms_data_with_meters.geojson", JSON.stringify(origFeatures), (err) => {
    if (err) throw err;
    console.log('The file has been saved!');
  });

  res.send("ok");
})

app.get('/gridelements', function (req, res) {
  console.log("Got gridelements request...");

  const pattern = new urlPattern(
		  /^\/gridelements(\?id=(.*))?$/,
		  ['params', 'id']
		);

	const results = pattern.match(req.url);

  var elems;

  if (typeof results.id != "undefined")
    // Get just the specified element.
    elems = gridElements.find({id: results.id});
  else {
    // Get all the elements.
    elems = gridElements.find();
  }

  var processedElements = {
    type: "FeatureCollection",
    features: []
  };

  elems.forEach(function(anElement) {
    if (anElement.geometry.coordinates == "UNKNOWN") {
      // This element has not position (typical for 'Load' or 'SmartInverter' type devices). Get the coordinate from its associated node.
      var nodeIds;

      if (anElement.properties.data.hasOwnProperty("ConnectedNodes"))
        nodeIds = anElement.properties.data.ConnectedNodes;
      else
        nodeIds = [anElement.properties.data.Node];

      nodeIds.forEach(function(aNodeId) {
        var aNode = nodes.find({id: aNodeId});

        if (aNode.length > 0) {
          anElement.geometry.coordinates = aNode[0].geometry.coordinates;
          processedElements.features.push(anElement);
        }
        else {
          console.log("Could not find node for " + anElement.properties.data.Id + " (" + aNodeId + ")");
        }
      });
    }
    else {
      // Use the existing location info associated directly with the element.
      processedElements.features.push(anElement);
    }
  });

  res.send(JSON.stringify(processedElements));
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(3000, function () {
	console.log('admsdataprocessor listening on port ' + 3000 + '!');
});

initialise();
