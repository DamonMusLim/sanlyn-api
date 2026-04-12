#!/bin/bash
# Add admin + migrate-orders routes to server.js
cd ~/Desktop/sanlyn-api-dev

FILE="server.js"

# 1. Add admin route (before accounts)
sed -i '' '/mount("\/api\/db\/accounts"/i\
mount("/api/db/admin",             () => import("./api/db/admin.js"));
' "$FILE"

# 2. Add migrate-orders route (after migrate-products)
sed -i '' '/mount("\/api\/db\/migrate-products"/a\
mount("/api/db/migrate-orders",    () => import("./api/db/migrate-orders.js"));
' "$FILE"

# 3. Clean up duplicate diag-shipping and fix-co-account lines
# Remove all duplicate diag-shipping lines (keep first)
awk '/diag-shipping/{if(++c>1)next}1' "$FILE" > "$FILE.tmp" && mv "$FILE.tmp" "$FILE"
# Remove all duplicate fix-co-account lines (keep first)
awk '/fix-co-account/{if(++c>1)next}1' "$FILE" > "$FILE.tmp" && mv "$FILE.tmp" "$FILE"
# Remove duplicate ocr-booking lines (keep first)
awk '/ocr-booking/{if(++c>1)next}1' "$FILE" > "$FILE.tmp" && mv "$FILE.tmp" "$FILE"

echo "=== Verify routes ==="
grep -n "admin\|migrate-orders" "$FILE"
echo "=== Check duplicates ==="
grep -c "diag-shipping" "$FILE"
grep -c "ocr-booking" "$FILE"
