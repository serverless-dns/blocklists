FROM nikolaik/python-nodejs:latest AS runner
# todo: is git required?
WORKDIR /app
COPY . .
# get deps
RUN python -m pip install aiohttp
RUN npm install aws-sdk

# run with the default entrypoint (usually, bash or sh)
CMD ["./run.sh"]
