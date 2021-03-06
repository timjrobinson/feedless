const pull = require("pull-stream");
const cat = require("pull-cat");
const debugPosts = require("debug")("queries:posts"),
  debugMessages = require("debug")("queries:messages"),
  debugFriends = require("debug")("queries:friends"),
  debugFriendshipStatus = require("debug")("queries:friendship_status"),
  debugSearch = require("debug")("queries:search"),
  debugProfile = require("debug")("queries:profile"),
  debugCommunities = require("debug")("queries:communities"),
  debugCommunityMembers = require("debug")("queries:communityMembers"),
  debugCommunityPosts = require("debug")("queries:communityPosts"),
  debugCommunityIsMember = require("debug")("queries:communityIsMember"),
  debugCommunityProfileCommunities = require("debug")(
    "queries:communityProfileCommunities"
  );
const paramap = require("pull-paramap");
const { promisePull, mapValues } = require("./utils");
const ssb = require("./ssb-client");

const latestOwnerValue = ({ key, dest }) => {
  return promisePull(
    ssb.client().query.read({
      reverse: true,
      query: [
        {
          $filter: {
            value: {
              author: dest,
              content: { type: "about", about: dest },
            },
          },
        },
      ],
    }),
    pull.filter((msg) => {
      return (
        msg.value.content &&
        key in msg.value.content &&
        !(msg.value.content[key] && msg.value.content[key].remove)
      );
    }),
    pull.take(1)
  ).then(([entry]) => {
    if (entry) {
      return entry.value.content[key];
    }
    return ssb.client().about.latestValue({ key, dest });
  });
};

const mapProfiles = (data, callback) =>
  getProfile(data.value.author)
    .then((author) => {
      data.value.authorProfile = author;
      callback(null, data);
    })
    .catch((err) => callback(err, null));

const getPosts = async (profile) => {
  debugPosts("Fetching");

  const posts = await promisePull(
    // @ts-ignore
    cat([
      ssb.client().query.read({
        reverse: true,
        query: [
          {
            $filter: {
              value: {
                private: { $not: true },
                content: {
                  root: profile.id,
                },
              },
            },
          },
        ],
        limit: 100,
      }),
      ssb.client().query.read({
        reverse: true,
        query: [
          {
            $filter: {
              value: {
                author: profile.id,
                private: { $not: true },
                content: {
                  type: "post",
                  root: { $not: true },
                  channel: { $not: true },
                },
              },
            },
          },
        ],
        limit: 100,
      }),
    ]),
    pull.filter((msg) => msg.value.content.type == "post"),
    paramap(mapProfiles)
  );

  debugPosts("Done");

  return mapValues(posts);
};

const getSecretMessages = async (profile) => {
  debugMessages("Fetching");
  const messagesPromise = promisePull(
    // @ts-ignore
    cat([
      ssb.client().private.read({
        reverse: true,
        limit: 100,
      }),
    ]),
    pull.filter(
      (msg) =>
        msg.value.content.type == "post" &&
        msg.value.content.recps &&
        msg.value.content.recps.includes(profile.id)
    )
  );

  const deletedPromise = promisePull(
    ssb.client().query.read({
      reverse: true,
      query: [
        {
          $filter: {
            value: {
              author: profile.id,
              content: {
                type: "delete",
              },
            },
          },
        },
      ],
    })
  ).then(Object.values);

  const [messages, deleted] = await Promise.all([
    messagesPromise,
    deletedPromise,
  ]);

  const deletedIds = deleted.map((x) => x.value.content.dest);

  const messagesByAuthor = {};
  for (const message of messages) {
    if (message.value.author == profile.id) {
      for (const recp of message.value.content.recps) {
        if (recp == profile.id) continue;
        if (!messagesByAuthor[recp]) {
          messagesByAuthor[recp] = {
            author: recp,
            messages: [],
          };
        }
      }
      continue;
    }

    const author = message.value.author;
    if (!messagesByAuthor[author]) {
      messagesByAuthor[author] = {
        author: message.value.author,
        messages: [],
      };
    }
    if (!deletedIds.includes(message.key))
      messagesByAuthor[author].messages.push(message);
  }

  const profilesList = await Promise.all(
    Object.keys(messagesByAuthor).map((id) => getProfile(id))
  );
  const profilesHash = profilesList.reduce((hash, profile) => {
    hash[profile.id] = profile;
    return hash;
  }, {});

  const chatList = Object.values(messagesByAuthor).map((m) => {
    m.authorProfile = profilesHash[m.author];
    return m;
  });

  debugMessages("Done");
  return chatList;
};

const search = async (search) => {
  debugSearch("Fetching");

  // https://stackoverflow.com/questions/3446170/escape-string-for-use-in-javascript-regex
  const normalizedSearch = search
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const safelyEscapedSearch = normalizedSearch.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
  const loosenSpacesSearch = safelyEscapedSearch.replace(" ", ".*");
  const searchRegex = new RegExp(`.*${loosenSpacesSearch}.*`, "i");

  const peoplePromise = promisePull(
    ssb.client().query.read({
      reverse: true,
      query: [
        {
          $filter: {
            value: {
              content: {
                type: "about",
                name: { $is: "string" },
              },
            },
          },
        },
      ],
    }),
    pull.filter((msg) => {
      if (!msg.value.content) return;

      const normalizedName = msg.value.content.name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
      return searchRegex.exec(normalizedName);
    }),
    paramap(mapProfiles)
  );

  const communitiesPostsPromise = promisePull(
    ssb.client().query.read({
      reverse: true,
      query: [
        {
          $filter: {
            value: {
              private: { $not: true },
              content: {
                type: "post",
                channel: { $truthy: true },
              },
            },
          },
        },
      ],
      limit: 3000,
    })
  );

  const [people, communitiesPosts] = await Promise.all([
    peoplePromise,
    communitiesPostsPromise,
  ]);

  const communities = Array.from(
    new Set(communitiesPosts.map((p) => p.value.content.channel))
  ).filter((name) => {
    const normalizedName = name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    return searchRegex.exec(normalizedName);
  });

  debugSearch("Done");
  return { people: Object.values(mapValues(people)), communities };
};

const getFriends = async (profile) => {
  debugFriends("Fetching");

  let graph = await ssb.client().friends.getGraph();

  let connections = {};
  for (let key in graph) {
    let isFollowing = graph[profile.id] && graph[profile.id][key] > 0;
    let isFollowingBack = graph[key] && graph[key][profile.id] > 0;
    if (isFollowing && isFollowingBack) {
      connections[key] = "friends";
    } else if (isFollowing && !isFollowingBack) {
      connections[key] = "requestsSent";
    } else if (!isFollowing && isFollowingBack) {
      if (!graph[profile.id] || graph[profile.id][key] === undefined)
        connections[key] = "requestsReceived";
    }
  }

  const profilesList = await Promise.all(
    Object.keys(connections).map((id) => getProfile(id))
  );
  const profilesHash = profilesList.reduce((hash, profile) => {
    hash[profile.id] = profile;
    return hash;
  }, {});

  let result = {
    friends: [],
    requestsSent: [],
    requestsReceived: [],
  };
  for (let key in connections) {
    result[connections[key]].push(profilesHash[key]);
  }

  debugFriends("Done");
  return result;
};

const getFriendshipStatus = async (source, dest) => {
  debugFriendshipStatus("Fetching");

  let requestRejectionsPromise = promisePull(
    ssb.client().query.read({
      reverse: true,
      query: [
        {
          $filter: {
            value: {
              author: source,
              content: {
                type: "contact",
                following: false,
              },
            },
          },
        },
      ],
      limit: 100,
    })
  ).then(mapValues);

  const [isFollowing, isFollowingBack, requestRejections] = await Promise.all([
    ssb.client().friends.isFollowing({ source: source, dest: dest }),
    ssb.client().friends.isFollowing({ source: dest, dest: source }),
    requestRejectionsPromise.then((x) => x.map((y) => y.content.contact)),
  ]);

  let status = "no_relation";
  if (isFollowing && isFollowingBack) {
    status = "friends";
  } else if (isFollowing && !isFollowingBack) {
    status = "request_sent";
  } else if (!isFollowing && isFollowingBack) {
    if (requestRejections.includes(dest)) {
      status = "request_rejected";
    } else {
      status = "request_received";
    }
  }
  debugFriendshipStatus("Done");

  return status;
};

const getAllEntries = (query) => {
  let queries = [];
  if (query.author) {
    queries.push({ $filter: { value: { author: query.author } } });
  }
  if (query.type) {
    queries.push({ $filter: { value: { content: { type: query.type } } } });
  }
  const queryOpts = queries.length > 0 ? { query: queries } : {};

  return promisePull(
    ssb.client().query.read({
      reverse: true,
      limit: 1000,
      ...queryOpts,
    })
  );
};

let profileCache = {};
const getProfile = async (id) => {
  if (profileCache[id]) return profileCache[id];

  let getKey = (key) => latestOwnerValue({ key, dest: id });

  let [name, image, description] = await Promise.all([
    getKey("name"),
    getKey("image"),
    getKey("description"),
  ]).catch((err) => {
    console.error("Could not retrieve profile for", id, err);
  });

  let profile = { id, name, image, description };
  profileCache[id] = profile;

  return profile;
};

const progress = (callback) => {
  pull(
    ssb.client().replicate.changes(),
    pull.drain(callback, (err) => {
      console.error("Progress drain error", err);
    })
  );
};

const autofollow = async (id) => {
  const isFollowing = await ssb.client().friends.isFollowing({
    source: ssb.client().id,
    dest: id,
  });

  if (!isFollowing) {
    await ssb.client().publish({
      type: "contact",
      contact: id,
      following: true,
      autofollow: true,
    });
  }
};

const getCommunities = async () => {
  debugCommunities("Fetching");

  const communitiesPosts = await promisePull(
    ssb.client().query.read({
      reverse: true,
      query: [
        {
          $filter: {
            value: {
              private: { $not: true },
              content: {
                type: "post",
                channel: { $truthy: true },
              },
            },
          },
        },
      ],
      limit: 1000,
    })
  );

  const communities = Array.from(
    new Set(communitiesPosts.map((p) => p.value.content.channel))
  );

  debugCommunities("Done");

  return communities;
};

const isMember = async (id, channel) => {
  debugCommunityIsMember("Fetching");
  const [lastSubscription] = await promisePull(
    ssb.client().query.read({
      reverse: true,
      limit: 1,
      query: [
        {
          $filter: {
            value: {
              author: id,
              content: {
                type: "channel",
                channel: channel,
              },
            },
          },
        },
      ],
    })
  );
  debugCommunityIsMember("Done");

  return lastSubscription && lastSubscription.value.content.subscribed;
};

const getCommunityMembers = async (name) => {
  debugCommunityMembers("Fetching");

  const communityMembers = await promisePull(
    ssb.client().query.read({
      reverse: true,
      query: [
        {
          $filter: {
            value: {
              content: {
                type: "channel",
                channel: name,
              },
            },
          },
        },
      ],
      limit: 100,
    }),
    paramap(mapProfiles)
  );
  const dedupMembers = {};
  for (const member of communityMembers) {
    const author = member.value.author;
    if (dedupMembers[author]) continue;
    dedupMembers[author] = member;
  }
  const onlySubscribedMembers = Object.values(dedupMembers).filter(
    (x) => x.value.content.subscribed
  );
  const memberProfiles = onlySubscribedMembers.map(
    (x) => x.value.authorProfile
  );

  debugCommunityMembers("Done");

  return memberProfiles;
};

const getProfileCommunities = async (id) => {
  debugCommunityProfileCommunities("Fetching");
  const subscriptions = await promisePull(
    ssb.client().query.read({
      reverse: true,
      query: [
        {
          $filter: {
            value: {
              author: id,
              content: {
                type: "channel",
              },
            },
          },
        },
      ],
    })
  );
  const dedupSubscriptions = {};
  for (const subscription of subscriptions) {
    const channel = subscription.value.content.channel;
    if (dedupSubscriptions[channel]) continue;
    dedupSubscriptions[channel] = subscription;
  }
  const onlyActiveSubscriptions = Object.values(dedupSubscriptions).filter(
    (x) => x.value.content.subscribed
  );
  const channelNames = onlyActiveSubscriptions.map(
    (x) => x.value.content.channel
  );
  debugCommunityProfileCommunities("Done");

  return channelNames;
};

const getPostWithReplies = async (channel, key) => {
  debugCommunityPosts("Fetching");

  const postWithReplies = await promisePull(
    // @ts-ignore
    cat([
      ssb.client().query.read({
        reverse: false,
        limit: 1,
        query: [
          {
            $filter: {
              key: key,
              value: {
                content: {
                  type: "post",
                  channel: channel,
                },
              },
            },
          },
        ],
      }),
      ssb.client().query.read({
        reverse: false,
        limit: 50,
        query: [
          {
            $filter: {
              value: {
                content: {
                  root: key,
                  channel: channel,
                },
              },
            },
          },
        ],
      }),
      ssb.client().query.read({
        reverse: false,
        limit: 50,
        query: [
          {
            $filter: {
              value: {
                content: {
                  reply: { $prefix: [key] },
                  channel: channel,
                },
              },
            },
          },
        ],
      }),
    ]),
    paramap(mapProfiles)
  );

  debugCommunityPosts("Done");
  return postWithReplies;
};

const getCommunityPosts = async (name) => {
  debugCommunityPosts("Fetching");

  const communityPosts = await promisePull(
    ssb.client().query.read({
      reverse: true,
      query: [
        {
          $filter: {
            value: {
              content: {
                type: "post",
                channel: name,
              },
            },
          },
        },
      ],
      limit: 1000,
    }),
    paramap(mapProfiles)
  );
  let communityPostsByKey = {};
  let replies = [];

  let rootKey = (post) => {
    let replyKey =
      post.value.content.reply && Object.keys(post.value.content.reply)[0];
    return replyKey || post.value.content.root;
  };

  for (let post of communityPosts) {
    if (rootKey(post)) {
      replies.push(post);
    } else {
      post.value.replies = [];
      communityPostsByKey[post.key] = post;
    }
  }
  for (let reply of replies) {
    let root = communityPostsByKey[rootKey(reply)];
    if (root) root.value.replies.push(reply);
  }

  debugCommunityPosts("Done");

  return Object.values(communityPostsByKey);
};

if (!global.clearProfileInterval) {
  global.clearProfileInterval = setInterval(() => {
    debugProfile("Clearing profile cache");
    profileCache = {};
  }, 5 * 60 * 1000);
}

module.exports = {
  mapProfiles,
  getPosts,
  search,
  getFriends,
  getAllEntries,
  getProfile,
  getSecretMessages,
  profileCache,
  getFriendshipStatus,
  getCommunities,
  getCommunityMembers,
  getCommunityPosts,
  getPostWithReplies,
  progress,
  autofollow,
  isMember,
  getProfileCommunities,
};
