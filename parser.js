const fs = require('fs');

function readFile(filePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}

function handleError(err) {
  console.error(err);
  process.exit(1);
}

function parseResults(data) {
  const lines = (
    data
      .split('\r\n')
      .map(
        line => line.split('\t').map(x => x.replace(/^\"/, '').replace(/\"$/, ''))
      )
  );
  const st = lines[1][1];
  const code = lines[1].filter((item, index) => index > 3).join('_');
  return { st,  code };
}

function printResults(results) {
  console.log(
    JSON.stringify(
      results
    )
  );
}

Promise.resolve(process.argv[2])
  .then(readFile)
  .then(parseResults)
  .then(printResults)
  .catch(handleError);
