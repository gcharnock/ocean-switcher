const lambda = require("./lambda").handler;

lambda().then(r => {
    console.log(r)
}).catch(e => {
    console.error(e);
});
