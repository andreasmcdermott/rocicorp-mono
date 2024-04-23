import {expect, test} from 'vitest';
import {joinSymbol} from '../ivm/types.js';
import {
  Album,
  Track,
  setup,
  createRandomArtists,
  createRandomAlbums,
  createRandomTracks,
  linkTracksToArtists,
  Artist,
} from '../benchmarks/setup.js';
import * as agg from '../query/agg.js';

test('left-join and aggregation to gather artists for a track', async () => {
  const {r, trackQuery, artistQuery, albumQuery, trackArtistQuery} = setup();

  const artists = createRandomArtists(5, true);
  const albums = createRandomAlbums(2, artists, true);
  const tracks = createRandomTracks(5, albums, true);
  // only link the first 2 tracks to artists
  const trackArtists = linkTracksToArtists(artists, tracks.slice(0, 2), true);

  await r.mutate.bulkSet({
    tracks,
    albums,
    artists,
    trackArtists,
  });

  const stmt = trackQuery
    .leftJoin(
      trackArtistQuery,
      'trackArtist',
      'track.id',
      'trackArtist.trackId',
    )
    .leftJoin(artistQuery, 'artists', 'trackArtist.artistId', 'id')
    .leftJoin(albumQuery, 'album', 'track.albumId', 'id')
    .groupBy('track.id')
    .select('track.*', 'album.*', agg.array('artists.*', 'artists'))
    .asc('track.id')
    .prepare();

  const rows = await stmt.exec();
  expect(rows).toEqual([
    {
      id: '1_1_1_1-1',
      trackArtist: {id: '1-1', trackId: '1', artistId: '1'},
      track: {id: '1', title: 'Track 1', length: 1000, albumId: '1'},
      artists: [
        {id: '1', name: 'Artist 1'},
        {id: '2', name: 'Artist 2'},
        {id: '3', name: 'Artist 3'},
        {id: '4', name: 'Artist 4'},
        {id: '5', name: 'Artist 5'},
      ],
      album: {id: '1', title: 'Album 1', artistId: '1'},
      [joinSymbol]: true,
    },
    {
      id: '1_1_2_2-1',
      trackArtist: {id: '2-1', trackId: '2', artistId: '1'},
      track: {id: '2', title: 'Track 2', length: 2000, albumId: '1'},
      artists: [
        {id: '1', name: 'Artist 1'},
        {id: '2', name: 'Artist 2'},
        {id: '3', name: 'Artist 3'},
        {id: '4', name: 'Artist 4'},
        {id: '5', name: 'Artist 5'},
      ],
      album: {id: '1', title: 'Album 1', artistId: '1'},
      [joinSymbol]: true,
    },
    {
      id: '1_3',
      track: {id: '3', title: 'Track 3', length: 3000, albumId: '1'},
      album: {id: '1', title: 'Album 1', artistId: '1'},
      artists: [],
      [joinSymbol]: true,
    },
    {
      id: '1_4',
      track: {id: '4', title: 'Track 4', length: 4000, albumId: '1'},
      album: {id: '1', title: 'Album 1', artistId: '1'},
      artists: [],
      [joinSymbol]: true,
    },
    {
      id: '1_5',
      track: {id: '5', title: 'Track 5', length: 5000, albumId: '1'},
      album: {id: '1', title: 'Album 1', artistId: '1'},
      artists: [],
      [joinSymbol]: true,
    },
  ]);
});

test('left-join through single table', async () => {
  const {r, trackQuery, albumQuery} = setup();

  const album: Album = {
    id: '1',
    artistId: '',
    title: 'album 1',
  };

  const track: Track = {
    id: '1',
    albumId: '1',
    title: 'track 1',
    length: 1,
  };

  await r.mutate.bulkSet({
    albums: [album],
    tracks: [track],
  });

  const stmt = trackQuery
    .leftJoin(albumQuery, 'album', 'albumId', 'id')
    .prepare();
  let rows = await stmt.exec();

  expect(rows).toEqual([
    {
      id: '1_1',
      track: {id: '1', albumId: '1', title: 'track 1', length: 1},
      album: {id: '1', artistId: '', title: 'album 1'},
      [joinSymbol]: true,
    },
  ]);

  await r.mutate.setTrack({
    id: '2',
    albumId: '2',
    title: 'track 2',
    length: 2,
  });

  rows = await stmt.exec();

  expect(rows).toEqual([
    {
      id: '1_1',
      track: {id: '1', albumId: '1', title: 'track 1', length: 1},
      album: {id: '1', artistId: '', title: 'album 1'},
      [joinSymbol]: true,
    },
    {
      id: '2',
      track: {id: '2', albumId: '2', title: 'track 2', length: 2},
      [joinSymbol]: true,
    },
  ]);

  await r.mutate.setAlbum({
    id: '2',
    artistId: '',
    title: 'album 2',
  });

  rows = await stmt.exec();

  expect(rows).toEqual([
    {
      id: '1_1',
      track: {id: '1', albumId: '1', title: 'track 1', length: 1},
      album: {id: '1', artistId: '', title: 'album 1'},
      [joinSymbol]: true,
    },
    {
      id: '2_2',
      album: {id: '2', artistId: '', title: 'album 2'},
      track: {id: '2', albumId: '2', title: 'track 2', length: 2},
      [joinSymbol]: true,
    },
  ]);

  await r.mutate.deleteTrack('1');

  rows = await stmt.exec();

  expect(rows).toEqual([
    {
      id: '2_2',
      album: {id: '2', artistId: '', title: 'album 2'},
      track: {id: '2', albumId: '2', title: 'track 2', length: 2},
      [joinSymbol]: true,
    },
  ]);

  await r.mutate.deleteAlbum('2');

  rows = await stmt.exec();

  expect(rows).toEqual([
    {
      id: '2',
      track: {id: '2', albumId: '2', title: 'track 2', length: 2},
      [joinSymbol]: true,
    },
  ]);
});

test('left-join through junction edge', async () => {
  const {r, trackQuery, artistQuery, trackArtistQuery} = setup();

  const album: Album = {
    id: '1',
    artistId: '1',
    title: 'album 1',
  };

  const tracks: Track[] = [
    {
      id: '1',
      albumId: '1',
      title: 'track 1',
      length: 1,
    },
    {
      id: '2',
      albumId: '1',
      title: 'track 2',
      length: 1,
    },
  ];

  const artists: Artist[] = [
    {
      id: '1',
      name: 'artist 1',
    },
    {
      id: '2',
      name: 'artist 2',
    },
  ];

  const trackArtists = [
    {
      id: '1-1',
      trackId: '1',
      artistId: '1',
    } as const,
    {
      id: '1-2',
      trackId: '1',
      artistId: '2',
    } as const,
  ];

  await r.mutate.bulkSet({
    albums: [album],
    tracks,
    trackArtists,
    artists,
  });

  const stmt = trackQuery
    .leftJoin(
      trackArtistQuery,
      'trackArtist',
      'track.id',
      'trackArtist.trackId',
    )
    .leftJoin(artistQuery, 'artists', 'trackArtist.artistId', 'id')
    .select('track.*')
    .asc('track.id')
    .prepare();

  const rows = await stmt.exec();

  expect(rows).toEqual([
    {
      id: '1_1-2_2',
      trackArtist: {id: '1-2', trackId: '1', artistId: '2'},
      track: {id: '1', albumId: '1', title: 'track 1', length: 1},
      artists: {id: '2', name: 'artist 2'},
      [joinSymbol]: true,
    },
    {
      id: '1_1_1-1',
      trackArtist: {id: '1-1', trackId: '1', artistId: '1'},
      track: {id: '1', albumId: '1', title: 'track 1', length: 1},
      artists: {id: '1', name: 'artist 1'},
      [joinSymbol]: true,
    },
    {
      id: '2',
      track: {id: '2', albumId: '1', title: 'track 2', length: 1},
      [joinSymbol]: true,
    },
  ]);
});
