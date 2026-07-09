#!/bin/bash
set -e

echo "1. Registering user..."
curl -s -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email": "test@tallei.ai", "password": "supersecure"}'

echo -e "\n2. Logging in..."
LOGIN_RES=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "test@tallei.ai", "password": "supersecure"}')

echo $LOGIN_RES
JWT=$(echo $LOGIN_RES | grep -o '"token":"[^"]*' | cut -d'"' -f4)

echo -e "\n3. Creating API Key..."
KEY_RES=$(curl -s -X POST http://localhost:3000/api/keys \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"name": "mcp_desktop"}')

echo $KEY_RES
API_KEY=$(echo $KEY_RES | grep -o '"key":"[^"]*' | cut -d'"' -f4)

echo -e "\n4. Saving Memory with API Key..."
curl -s -X POST http://localhost:3000/api/memories \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "API Key auth validation memory test.", "platform": "claude"}'
