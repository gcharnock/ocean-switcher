const https = require("https");

const API_TOKEN = process.env.API_TOKEN;
const IMAGE_NAMESPACE = process.env.IMAGE_NAMESPACE;
const DROPLET_NAMESPACE = process.env.DROPLET_NAMESPACE;
const DROPLET_NAME = process.env.DROPLET_NAME;

const hoursToRun = new Set([]);

//curl -X GET -H 'Content-Type: application/json' -H 'Authorization: Bearer b7d03a6947b217efb6f3ec3bd3504582' "https://api.digitalocean.com/v2/snapshots?page=1&per_page=1"



function compareOn(f) {
    return function compare(a, b) {
        if (f(a) < f(b)) {
            return -1;
        }
        if (f(a) > f(b)) {
            return 1;
        }
        return 0;
    }
}

function dropletImageName(dropletId) {
    return IMAGE_NAMESPACE + dropletId;
}

function sleep(timeMS) {
    return new Promise((resolve) => {
        setTimeout(resolve, timeMS);
    });
}

function request(method, path, body) {
    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(body);
        const headers = {
            "Authorization": "Bearer " + API_TOKEN,
            "Content-Type": "application/json",
        };
        if (body !== undefined) {
            headers["Content-Length"] = bodyStr.length;
        }
        const options = {
            host: 'api.digitalocean.com',
            path: path,
            port: 443,
            method: method,
            headers
        };

        const req = https.request(options);

        req.on("response", (res) => {
            if (res.statusCode === 200 || res.statusCode === 202 || res.statusCode === 201) {
                let body = "";
                res.on("data", chunk => {
                    body += chunk;
                });
                res.on("end", () => {
                    console.log(method + ": " + path + " => " + res.statusCode + " body = " + body);
                    resolve(JSON.parse(body));
                })
            } else {
                let body = "";
                res.on("data", chunk => {
                    body += chunk;
                });
                res.on("end", () => {
                    console.log(method + ": " + path + " => " + res.statusCode + " body = " + body);
                    reject(new Error("Rejected with error " + res.statusCode + "" + body));
                });
            }
        });

        req.on('error', (e) => {
            reject(e.message);
        });

        // send the request
        if (body !== undefined) {
            req.write(bodyStr);
        }
        req.end();
    });
}

async function waitOnAction(action) {
    const start = new Date();
    while (action.status === "in-progress") {
        await sleep(5000);
        action = await request("GET", "/v2/actions/" + action.id);
        if (new Date().getTime() - start.getTime() > 1000 * 120) {
            action = {status: "errored"};
            break;
        }
    }
    return action;
}

async function findImageForDroplet(dropletId) {
    const images = (await request("GET", "/v2/images?private=true")).images;
    const expectedImageName = dropletImageName(dropletId);
    return images.find(image => image.name === expectedImageName);
}

async function safeKillDroplet(dropletId) {
    console.log("Permanently killing droplet: " + dropletId + ". Final check the the snapshot exists");
    const foundImage = findImageForDroplet(dropletId);
    if(foundImage) {
        console.log("Image found with id " + foundImage.id + ". proceeding with delete");
        await request("DELETE", "/v2/droplets/" + dropletId);
        console.log("Delete complete");
    } else {
        console.error("refusing to delete droplet as image is missing");
        return false;
    }
}

async function shutdownDroplet(dropletId) {
    while(true) {
        const droplet = (await request("GET", "/v2/droplets/" + dropletId)).droplet;
        if(droplet.locked) {
            console.log("droplet locked, waiting for actions to complete");
            await sleep(15000);
            continue;
        } else if(droplet.status === "active" || droplet.status === "new") {
            console.log("droplet was on, we need to run it off");
            let action = await request("POST", "/v2/droplets/" + dropletId + "/actions", {
                "type": "shutdown"
            });
            console.log("droplet set to shutting down. ActionId = " + action.id);
            action = waitOnAction(action);
            if (action.status === "errored") {
                console.log("shutdown errored. Trying a hard power off");
                action = await request("POST", "/v2/droplets/" + dropletId + "/actions", {
                    "type": "power_off"
                });
                action = await waitOnAction(action);
            }
            console.log("Shutdown completed: " + JSON.stringify(action));
            continue;
        } else if(droplet.status === "off" || droplet.status === "archive") {
            console.log("droplet was off. We need to check it has a snapshot, then kill it.");
            const image = await findImageForDroplet(dropletId);
            if(!image) {
                const snapshortAction = await request("POST", "/v2/droplets/" + dropletId + "/actions", {
                    "type": "snapshot",
                    "name": dropletImageName(dropletId)
                });
                await waitOnAction(snapshortAction);
            }
            console.log("okay,we should have an image for the snapshot now. Deleting it.");
            const result = await safeKillDroplet(dropletId);
            if(result) {
                break;
            } else {
                console.error("safe kill failed. Starting again from the top");
                await sleep(15000);
            }
        } else {
            throw new Error("Droplet has unknown status: " + droplet.status);
        }
    }
}

async function restoreDroplet(imageId) {
    await request("POST", "/v2/droplets", {
        "name": DROPLET_NAME,
        "region": "lon1",
        "size": "s-1vcpu-3gb",
        "image": imageId,
        "ssh_keys": [
            "60:d4:a3:6c:ad:b8:8f:f2:cc:85:8d:9a:8a:11:bd:55"
        ],
        "backups": false,
        "ipv6": true,
        "user_data": null,
        "private_networking": null,
        "volumes": null,
        "tags": [
            DROPLET_NAMESPACE
        ]
    });
}

async function getSnapshots() {
    return (await request("GET", '/v2/snapshots')).snapshots;
}

async function getDroplets() {
    return (await request("GET", "/v2/droplets?tag_name=" + DROPLET_NAMESPACE)).droplets;
}

function getShouldRun() {
    return hoursToRun.has(new Date().getUTCHours());
}

function isDropletRunning(droplets) {
    return (droplets.length > 0);
}

async function shutdownServer(droplets, snapshots) {
    await Promise.all(droplets.map(droplet => shutdownDroplet(droplet.id)));
}

async function startupServer(droplets, snapshots) {
    console.log("Starting the server");

    const sorted = snapshots.sort(compareOn(s => s.created_at));
    const latest = sorted[sorted.length - 1];
    console.log("latest snapshots is: ", latest);
    await restoreDroplet(latest.id);
    console.log("Issued start request, server should now start");
}

async function main(event) {
    const [snapshots, droplets] = await Promise.all([getSnapshots(), getDroplets()]);

    const shouldRun = getShouldRun();
    const isRunning = isDropletRunning(droplets);

    console.log(shouldRun ? "The droplet should be running" : "The droplet should not be running");
    console.log(isRunning ? "The droplet is running" : "The droplet is not running");

    if (shouldRun === isRunning) {
        console.log("Everything is as it should be.");
    } else {
        if (shouldRun) {
            await startupServer(droplets, snapshots);
        } else {
            await shutdownServer(droplets, snapshots);
        }
    }

    return {
        statusCode: 200,
        body: {}
    };
}

exports.handler = main;
