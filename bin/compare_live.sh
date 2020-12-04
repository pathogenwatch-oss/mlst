#!/bin/bash

echo "Don't just run this, edit it a bit"
exit 1

# On a database, maybe not the master
cat <<'EOF' | sudo docker exec -i $(sudo docker ps | awk '$2 ~ /mongo/ { print $1 }') mongo --quiet pw-live | tee /tmp/mlst.csv
rs.slaveOk()
var fileIds = []
print("fileId,version,st")
db.analyses.find(
  { "task": "mlst", "version": "202004091529-v2.4.0" },
  { "results.st": 1, "fileId": 1, "version": 1 }
).limit(20000).forEach(d => {
  fileIds.push(d.fileId)
  print(`${d.fileId},${d.version},${d.results.st}`)
})
db.analyses.find(
  { "task": "mlst", "version": "202011162044-v2.6.3", "fileId": { "$in": fileIds }},
  { "results.st": 1, "fileId": 1, "version": 1 }
).forEach(d => {
  fileIds.push(d.fileId)
  print(`${d.fileId},${d.version},${d.results.st}`)
})
EOF

# Probably on your local machine
cat <<'EOF' | python3
import pandas as pd
df = pd.read_csv("/tmp/mlst.csv")
df = df.pivot(index="fileId", columns="version", values="st")
diff = df[df["202004091529-v2.4.0"] != df["202011162044-v2.6.3"]]
diff = diff.fillna("")
print("Improvements")
print(diff[diff["202011162044-v2.6.3"].str.isnumeric()])

print("\nRegressions")
print(diff[diff["202004091529-v2.4.0"].str.isnumeric()])
EOF