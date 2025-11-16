# Use the official Node.js image
FROM node:20

# Set the working directory
WORKDIR /app

# Install Java (required for Firebase emulators)
# Use openjdk-17 which is available on Debian bookworm used by node:20
RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-17-jre-headless ca-certificates netcat-openbsd \
  && rm -rf /var/lib/apt/lists/*

# Copy project files into the container
COPY package*.json ./
COPY frontend/package*.json frontend/
COPY functions/package*.json functions/
COPY firebase.json ./
COPY firestore.rules ./
COPY firestore.indexes.json ./
COPY functions ./functions
COPY deployments ./deployments
COPY contracts ./contracts
COPY scripts ./scripts
COPY frontend ./frontend
# Avoid copying entire workspace to prevent invalid file requests (node_modules, symlinks)

# Do not install devDependencies in the runtime emulator image - keep it production-like
ENV NODE_ENV=production
# Install Firebase CLI globally and project dependencies; install functions deps specifically
RUN npm install -g firebase-tools \
  && npm install --no-audit --no-fund --legacy-peer-deps \
  && if [ -f functions/package.json ]; then (cd functions && npm install --no-audit --no-fund --legacy-peer-deps); fi

# Expose necessary ports
EXPOSE 8080 5001 4000 4400

# Start Firebase emulators
CMD ["firebase", "emulators:start", "--only", "firestore,functions", "--import=./", "--project=poker-4683e"]
