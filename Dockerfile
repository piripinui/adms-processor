FROM node:8

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

RUN npm install
# If you are building your code for production
# RUN npm install --only=production

# Bundle app source
COPY . .
# Copy data.
ADD ./data ./data
# Copy public
ADD ./public ./public

EXPOSE 3000
CMD [ "npm", "start" ]
#CMD \
#  ["/bin/bash"]
