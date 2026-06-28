#!/bin/bash
# Add migrate-orders-v2 and order-create-v2 routes to server.js
cd ~/Desktop/sanlyn-api-dev
FILE="server.js"

# Check if already added
if grep -q "migrate-orders-v2" "$FILE"; then
  echo "Routes already exist"
else
  sed -i '' '/mount("\/api\/db\/migrate-orders"/a\
mount("/api/db/migrate-orders-v2", () => import("./api/db/migrate-orders-v2.js"));\
mount("/api/db/order-create-v2",   () => import("./api/db/order-create-v2.js"));
' "$FILE"
  echo "Routes added"
fi

echo "=== Verify ==="
grep -n "v2" "$FILE"
